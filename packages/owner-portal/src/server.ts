import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import {
  verifyOwnerCredentials,
  createSession,
  getOwnerIdForSessionToken,
  venueBelongsToOwner,
  recordCalibrationSample,
  computeVenueHeatmap,
  computeReturnVisitStats,
  getOwnerTier,
  setOwnerTier,
  tierAllowsHeatmap,
  applyTierToReturnVisitStats,
  getVenuesForOwner,
  getApNodesForVenue,
  createOwnerWithPassword,
  createVenue,
  createApNode,
  recordBillingTransaction,
  getBillingHistory,
  simulateMonthlyBillingCharge,
  type SubscriptionTier,
} from "@floorsense/backend";
import { renderDashboardPage } from "./dashboardPage.ts";

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const CALIBRATION_PATH = /^\/venues\/([^/]+)\/calibration-samples$/;
const AP_NODES_PATH = /^\/venues\/([^/]+)\/ap-nodes$/;
const HEATMAP_PATH = /^\/venues\/([^/]+)\/heatmap$/;
const RETURN_VISIT_STATS_PATH = /^\/venues\/([^/]+)\/return-visit-stats$/;

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk: Buffer) => {
      data += chunk.toString("utf-8");
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve(null);
      }
    });
  });
}

/** node:sqlite's extended result code for SQLITE_CONSTRAINT_UNIQUE. */
const SQLITE_CONSTRAINT_UNIQUE = 2067;

function isUniqueConstraintViolation(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err as { code?: string; errcode?: number }).code === "ERR_SQLITE_ERROR" &&
    (err as { code?: string; errcode?: number }).errcode === SQLITE_CONSTRAINT_UNIQUE
  );
}

const VALID_TIERS: SubscriptionTier[] = ["basic", "standard", "premium"];

/**
 * Temporary test override, per explicit user instruction: an owner
 * registering under this exact name gets full/all-tier privileges to try
 * the app out. Remove this constant and its one call site to retire it.
 */
const WALI_TEST_OVERRIDE_NAME = "Wali";

function extractBearerToken(req: IncomingMessage): string | null {
  const header = req.headers["authorization"];
  if (typeof header !== "string") return null;
  const match = /^Bearer (.+)$/.exec(header);
  return match?.[1] ?? null;
}

type AuthResolution = { ok: true; ownerId: string } | { ok: false; status: 401 | 404 };

/** Verifies the caller owns venueId via a real DB query. 404 (not 403) so a wrong owner can't confirm the venue exists. */
function resolveAuthenticatedOwnerForVenue(db: DatabaseSync, req: IncomingMessage, venueId: string): AuthResolution {
  const token = extractBearerToken(req);
  const ownerId = token ? getOwnerIdForSessionToken(db, token, Date.now()) : null;
  if (!ownerId) return { ok: false, status: 401 };
  if (!venueBelongsToOwner(db, ownerId, venueId)) return { ok: false, status: 404 };
  return { ok: true, ownerId };
}

function writeAuthFailure(res: ServerResponse, status: 401 | 404): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: status === 401 ? "unauthorized" : "not found" }));
}

/** For routes not scoped to one venueId, like listing an owner's own venues. */
function resolveAuthenticatedOwner(db: DatabaseSync, req: IncomingMessage): { ok: true; ownerId: string } | { ok: false } {
  const token = extractBearerToken(req);
  const ownerId = token ? getOwnerIdForSessionToken(db, token, Date.now()) : null;
  if (!ownerId) return { ok: false };
  return { ok: true, ownerId };
}

/**
 * Owner-facing HTTP API. Tenant identity is resolved per-request from a
 * bearer token (unlike captive-portal, which fixes tenant/venue per instance).
 * Plain HTTP, no TLS: a real deployment needs TLS in front of this.
 */
export function createOwnerPortalServer(db: DatabaseSync): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderDashboardPage());
      return;
    }

    if (req.method === "POST" && url.pathname === "/auth/login") {
      readJsonBody(req)
        .then((body) => {
          const b = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : null;
          const name = b?.["name"];
          const password = b?.["password"];

          if (typeof name !== "string" || typeof password !== "string") {
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "invalid credentials" }));
            return;
          }

          const ownerId = verifyOwnerCredentials(db, name, password);
          if (!ownerId) {
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "invalid credentials" }));
            return;
          }

          const token = createSession(db, ownerId, Date.now(), SESSION_TTL_MS);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ token }));
        })
        .catch(() => {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid credentials" }));
        });
      return;
    }

    if (req.method === "POST" && url.pathname === "/auth/register") {
      readJsonBody(req)
        .then((body) => {
          const b = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : null;
          const name = b?.["name"];
          const password = b?.["password"];
          const requestedTier = b?.["tier"];

          if (
            typeof name !== "string" ||
            name.length === 0 ||
            typeof password !== "string" ||
            password.length === 0 ||
            typeof requestedTier !== "string" ||
            !VALID_TIERS.includes(requestedTier as SubscriptionTier)
          ) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "name, password, and a valid tier are required" }));
            return;
          }

          let owner;
          try {
            owner = createOwnerWithPassword(db, name, password);
          } catch (err) {
            if (isUniqueConstraintViolation(err)) {
              res.writeHead(409, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "that name is already registered" }));
              return;
            }
            throw err; // some other DB error, let it surface as 500 below.
          }

          const effectiveTier: SubscriptionTier =
            name === WALI_TEST_OVERRIDE_NAME ? "premium" : (requestedTier as SubscriptionTier);
          setOwnerTier(db, owner.id, effectiveTier);
          recordBillingTransaction(db, owner.id, effectiveTier, "signup", Date.now());

          // Tier and payment are settled above before the token is issued, so access follows a completed purchase.
          const token = createSession(db, owner.id, Date.now(), SESSION_TTL_MS);
          res.writeHead(201, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ token, tier: effectiveTier }));
        })
        .catch(() => {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "internal error" }));
        });
      return;
    }

    if (req.method === "GET" && url.pathname === "/billing/history") {
      const auth = resolveAuthenticatedOwner(db, req);
      if (!auth.ok) {
        writeAuthFailure(res, 401);
        return;
      }

      const history = getBillingHistory(db, auth.ownerId);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(history));
      return;
    }

    if (req.method === "POST" && url.pathname === "/billing/simulate-monthly-charge") {
      const auth = resolveAuthenticatedOwner(db, req);
      if (!auth.ok) {
        writeAuthFailure(res, 401);
        return;
      }

      const transaction = simulateMonthlyBillingCharge(db, auth.ownerId, Date.now());
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify(transaction));
      return;
    }

    if (req.method === "GET" && url.pathname === "/venues") {
      const auth = resolveAuthenticatedOwner(db, req);
      if (!auth.ok) {
        writeAuthFailure(res, 401);
        return;
      }

      const venues = getVenuesForOwner(db, auth.ownerId);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(venues));
      return;
    }

    if (req.method === "POST" && url.pathname === "/venues") {
      const auth = resolveAuthenticatedOwner(db, req);
      if (!auth.ok) {
        writeAuthFailure(res, 401);
        return;
      }

      readJsonBody(req)
        .then((body) => {
          const b = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : null;
          const name = b?.["name"];
          const floorWidth = b?.["floorWidth"];
          const floorHeight = b?.["floorHeight"];

          if (typeof name !== "string" || typeof floorWidth !== "number" || typeof floorHeight !== "number") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "invalid body" }));
            return;
          }

          const venue = createVenue(db, auth.ownerId, { name, floorWidth, floorHeight });
          res.writeHead(201, { "Content-Type": "application/json" });
          res.end(JSON.stringify(venue));
        })
        .catch(() => {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "internal error" }));
        });
      return;
    }

    const apNodesMatch = AP_NODES_PATH.exec(url.pathname);
    if (req.method === "GET" && apNodesMatch) {
      const venueId = apNodesMatch[1] as string;
      const auth = resolveAuthenticatedOwnerForVenue(db, req, venueId);
      if (!auth.ok) {
        writeAuthFailure(res, auth.status);
        return;
      }

      // Not tier-gated: an owner needs this to calibrate their own venue regardless of plan.
      const apNodes = getApNodesForVenue(db, auth.ownerId, venueId);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(apNodes));
      return;
    }

    if (req.method === "POST" && apNodesMatch) {
      const venueId = apNodesMatch[1] as string;
      const auth = resolveAuthenticatedOwnerForVenue(db, req, venueId);
      if (!auth.ok) {
        writeAuthFailure(res, auth.status);
        return;
      }

      readJsonBody(req)
        .then((body) => {
          const b = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : null;
          const apNodeId = b?.["apNodeId"];
          const x = b?.["x"];
          const y = b?.["y"];

          if (typeof apNodeId !== "string" || apNodeId.length === 0 || typeof x !== "number" || typeof y !== "number") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "invalid body" }));
            return;
          }

          let apNode;
          try {
            apNode = createApNode(db, venueId, { apNodeId, x, y });
          } catch (err) {
            if (isUniqueConstraintViolation(err)) {
              res.writeHead(409, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "an AP node with that ID already exists in this venue" }));
              return;
            }
            throw err; // some other DB error, let it surface as 500 below.
          }

          res.writeHead(201, { "Content-Type": "application/json" });
          res.end(JSON.stringify(apNode));
        })
        .catch(() => {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "internal error" }));
        });
      return;
    }

    const calibrationMatch = CALIBRATION_PATH.exec(url.pathname);
    if (req.method === "POST" && calibrationMatch) {
      const venueId = calibrationMatch[1] as string;
      const auth = resolveAuthenticatedOwnerForVenue(db, req, venueId);
      if (!auth.ok) {
        writeAuthFailure(res, auth.status);
        return;
      }

      readJsonBody(req)
        .then((body) => {
          const b = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : null;
          const apNodeId = b?.["apNodeId"];
          const rssi = b?.["rssi"];
          const knownX = b?.["knownX"];
          const knownY = b?.["knownY"];

          if (
            typeof apNodeId !== "string" ||
            typeof rssi !== "number" ||
            typeof knownX !== "number" ||
            typeof knownY !== "number"
          ) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "invalid body" }));
            return;
          }

          recordCalibrationSample(db, { tenantId: auth.ownerId, venueId, apNodeId, rssi, knownX, knownY });
          res.writeHead(201, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ recorded: true }));
        })
        .catch(() => {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "internal error" }));
        });
      return;
    }

    const heatmapMatch = HEATMAP_PATH.exec(url.pathname);
    if (req.method === "GET" && heatmapMatch) {
      const venueId = heatmapMatch[1] as string;
      const auth = resolveAuthenticatedOwnerForVenue(db, req, venueId);
      if (!auth.ok) {
        writeAuthFailure(res, auth.status);
        return;
      }

      const tier = getOwnerTier(db, auth.ownerId);
      if (!tierAllowsHeatmap(tier)) {
        // 402 Payment Required: upgrading the tier resolves this, unlike a 403.
        res.writeHead(402, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "upgrade required", requiredTier: "standard" }));
        return;
      }

      const heatmap = computeVenueHeatmap(db, auth.ownerId, venueId);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(heatmap));
      return;
    }

    const statsMatch = RETURN_VISIT_STATS_PATH.exec(url.pathname);
    if (req.method === "GET" && statsMatch) {
      const venueId = statsMatch[1] as string;
      const auth = resolveAuthenticatedOwnerForVenue(db, req, venueId);
      if (!auth.ok) {
        writeAuthFailure(res, auth.status);
        return;
      }

      // Tier is looked up fresh per request, so a tier change applies immediately.
      const tier = getOwnerTier(db, auth.ownerId);
      const stats = applyTierToReturnVisitStats(computeReturnVisitStats(db, auth.ownerId, venueId), tier);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(stats));
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  });
}

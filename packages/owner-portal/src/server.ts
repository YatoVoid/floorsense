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
  tierAllowsHeatmap,
  applyTierToReturnVisitStats,
  getVenuesForOwner,
} from "@floorsense/backend";
import { renderDashboardPage } from "./dashboardPage.ts";

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const CALIBRATION_PATH = /^\/venues\/([^/]+)\/calibration-samples$/;
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

function extractBearerToken(req: IncomingMessage): string | null {
  const header = req.headers["authorization"];
  if (typeof header !== "string") return null;
  const match = /^Bearer (.+)$/.exec(header);
  return match?.[1] ?? null;
}

type AuthResolution = { ok: true; ownerId: string } | { ok: false; status: 401 | 404 };

/**
 * Resolves the authenticated owner for a request AND verifies (via a real
 * DB query, never trusting the client) that they own the given venueId.
 * 404 — not 403 — for a wrong owner or a nonexistent venue: don't confirm
 * to a non-owner that a venueId exists at all, consistent with login's own
 * no-information-leak principle.
 */
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

/** Resolves the authenticated owner for a request with no venue-ownership check — for routes (like listing an owner's own venues) that aren't scoped to one specific venueId. */
function resolveAuthenticatedOwner(db: DatabaseSync, req: IncomingMessage): { ok: true; ownerId: string } | { ok: false } {
  const token = extractBearerToken(req);
  const ownerId = token ? getOwnerIdForSessionToken(db, token, Date.now()) : null;
  if (!ownerId) return { ok: false };
  return { ok: true, ownerId };
}

/**
 * The owner-facing HTTP API. Unlike @floorsense/captive-portal (device-
 * facing, tenant/venue fixed per server instance), this server serves many
 * owners from one process — tenant identity is resolved per-request from a
 * bearer session token, never fixed at construction time.
 *
 * Plain HTTP, no TLS — a documented limitation of this local-dev proof of
 * concept. A real deployment must terminate TLS in front of this server;
 * session tokens are not protected in transit otherwise.
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
        // 402 (Payment Required), not 403: this is a real, if uncommonly
        // used, HTTP status many real APIs use for "upgrade required"
        // scenarios — distinct from 403's "you will never be allowed"
        // semantic, since upgrading the tier resolves this. The heatmap is
        // never computed at all in this branch.
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

      // Tier is looked up fresh per request (never cached in the session
      // token), so a tier change takes effect immediately for any
      // already-issued session — not a perceived bug if a token's owner's
      // access changes mid-session.
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

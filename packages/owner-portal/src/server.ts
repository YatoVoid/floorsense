import { createServer, type IncomingMessage, type Server } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import {
  verifyOwnerCredentials,
  createSession,
  getOwnerIdForSessionToken,
  venueBelongsToOwner,
  recordCalibrationSample,
} from "@floorsense/backend";

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const CALIBRATION_PATH = /^\/venues\/([^/]+)\/calibration-samples$/;

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

    const calibrationMatch = CALIBRATION_PATH.exec(url.pathname);
    if (req.method === "POST" && calibrationMatch) {
      const venueId = calibrationMatch[1] as string;
      const token = extractBearerToken(req);
      const ownerId = token ? getOwnerIdForSessionToken(db, token, Date.now()) : null;

      if (!ownerId) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }

      // Real DB-level ownership check — a valid token for a DIFFERENT
      // owner's venueId must not succeed. 404 (not 403): don't confirm to a
      // non-owner that this venueId exists at all, consistent with login's
      // own no-information-leak principle.
      if (!venueBelongsToOwner(db, ownerId, venueId)) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
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

          recordCalibrationSample(db, { tenantId: ownerId, venueId, apNodeId, rssi, knownX, knownY });
          res.writeHead(201, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ recorded: true }));
        })
        .catch(() => {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "internal error" }));
        });
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  });
}

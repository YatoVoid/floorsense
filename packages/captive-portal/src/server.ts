import { createServer, type IncomingMessage, type Server } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { recordConsentGrant } from "@floorsense/backend";
import { renderSplashPage } from "./splashPage.ts";

export interface CaptivePortalConfig {
  tenantId: string;
  venueId: string;
  venueName: string;
  termsVersion: string;
}

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

/**
 * Creates the captive-portal HTTP server for a single venue. tenantId and
 * venueId are fixed at server-creation time (not client-supplied) — a
 * device connecting to this portal can only ever grant consent for the
 * venue this portal instance actually serves, not an arbitrary one it
 * names in a request.
 */
export function createCaptivePortalServer(db: DatabaseSync, config: CaptivePortalConfig): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "GET" && url.pathname === "/") {
      const hashedDeviceId = url.searchParams.get("deviceId") ?? "";
      const html = renderSplashPage({
        venueName: config.venueName,
        hashedDeviceId,
        termsVersion: config.termsVersion,
      });
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    if (req.method === "POST" && url.pathname === "/consent/accept") {
      readJsonBody(req)
        .then((body) => {
          const hashedDeviceId =
            body !== null && typeof body === "object" && "hashedDeviceId" in body
              ? (body as Record<string, unknown>)["hashedDeviceId"]
              : undefined;

          if (typeof hashedDeviceId !== "string" || hashedDeviceId.length === 0) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "hashedDeviceId is required" }));
            return;
          }

          recordConsentGrant(db, {
            tenantId: config.tenantId,
            venueId: config.venueId,
            hashedDeviceId,
            termsVersion: config.termsVersion,
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ accepted: true }));
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

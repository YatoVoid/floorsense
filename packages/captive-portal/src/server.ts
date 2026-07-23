import { createServer, type IncomingMessage, type Server } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { hashDeviceId } from "@floorsense/shared";
import { recordConsentGrant } from "@floorsense/backend";
import { renderSplashPage } from "./splashPage.ts";

export interface CaptivePortalConfig {
  tenantId: string;
  venueId: string;
  venueName: string;
  termsVersion: string;
  /** Optional: when set, a `rawMac` query param is hashed with this salt server-side (real AP hardware redirects with the raw MAC, never computing the hash itself - matches the venue's hardwareToken in a real deployment). Without it, only the existing already-hashed `deviceId` param works. */
  deviceIdSalt?: string;
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

/** tenantId/venueId are fixed at creation time, so a device can only grant consent for the venue this portal actually serves. */
export function createCaptivePortalServer(db: DatabaseSync, config: CaptivePortalConfig): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "GET" && url.pathname === "/") {
      const rawMac = url.searchParams.get("rawMac");
      const hashedDeviceId =
        rawMac !== null && config.deviceIdSalt !== undefined
          ? hashDeviceId(rawMac, config.deviceIdSalt)
          : (url.searchParams.get("deviceId") ?? "");
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

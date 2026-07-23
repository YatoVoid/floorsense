import type { DatabaseSync } from "node:sqlite";
import { openDatabase, getVenueById } from "@floorsense/backend";
import { createCaptivePortalServer, type CaptivePortalConfig } from "./server.ts";

export type CaptivePortalStartupResult =
  | { ok: true; config: CaptivePortalConfig }
  | { ok: false; error: string };

/** Looks up a real venue and builds the config a real captive-portal server needs - deviceIdSalt is the venue's own hardwareToken, so hashes match what POST /hardware/events computes for the same device. */
export function buildCaptivePortalConfigForVenue(
  db: DatabaseSync,
  venueId: string,
  termsVersion: string
): CaptivePortalStartupResult {
  const venue = getVenueById(db, venueId);
  if (!venue) {
    return { ok: false, error: `No venue found with id "${venueId}". Check VENUE_ID against GET /venues.` };
  }
  return {
    ok: true,
    config: {
      tenantId: venue.ownerId,
      venueId: venue.id,
      venueName: venue.name,
      termsVersion,
      deviceIdSalt: venue.hardwareToken,
    },
  };
}

/** Run directly: `node src/startRealServer.ts <venueId> [termsVersion] [port]` */
if (import.meta.url === `file://${process.argv[1]}`) {
  const venueId = process.argv[2];
  if (!venueId) {
    console.error("Usage: node src/startRealServer.ts <venueId> [termsVersion] [port]");
    console.error("Find venueId (and its hardwareToken) via GET /venues while logged in as that venue's owner.");
    process.exit(1);
  }
  const termsVersion = process.argv[3] ?? "v1";
  const port = Number(process.argv[4] ?? 3001);

  const db = openDatabase();
  const result = buildCaptivePortalConfigForVenue(db, venueId, termsVersion);
  if (!result.ok) {
    console.error(result.error);
    process.exit(1);
  }

  const server = createCaptivePortalServer(db, result.config);
  server.listen(port, () => {
    console.log(`Captive portal for "${result.config.venueName}" listening on http://0.0.0.0:${port}`);
  });
}

import assert from "node:assert";
import { test } from "node:test";
import { openDatabase, createOwner, createVenue } from "@floorsense/backend";
import { buildCaptivePortalConfigForVenue } from "./startRealServer.ts";

test("buildCaptivePortalConfigForVenue: an unknown venueId fails clearly, without producing a server config to start", () => {
  const db = openDatabase(":memory:");
  const result = buildCaptivePortalConfigForVenue(db, "no-such-venue", "v1");
  assert.strictEqual(result.ok, false);
  assert.ok(!result.ok);
  assert.match(result.error, /no-such-venue/, "the error should name the bad venueId, not just say 'not found'");
  db.close();
});

test("buildCaptivePortalConfigForVenue: a real venue produces a config using its own tenantId/name/hardwareToken", () => {
  const db = openDatabase(":memory:");
  const owner = createOwner(db, "Real Server Test Owner");
  const venue = createVenue(db, owner.id, { name: "Real Server Test Venue", floorWidth: 10, floorHeight: 8 });

  const result = buildCaptivePortalConfigForVenue(db, venue.id, "v2");
  assert.strictEqual(result.ok, true);
  assert.ok(result.ok);
  assert.strictEqual(result.config.tenantId, owner.id);
  assert.strictEqual(result.config.venueId, venue.id);
  assert.strictEqual(result.config.venueName, "Real Server Test Venue");
  assert.strictEqual(result.config.termsVersion, "v2");
  assert.strictEqual(
    result.config.deviceIdSalt,
    venue.hardwareToken,
    "the salt used to hash devices in the consent flow must be the SAME token /hardware/events authenticates with, so a device's hash matches across both paths"
  );
  db.close();
});

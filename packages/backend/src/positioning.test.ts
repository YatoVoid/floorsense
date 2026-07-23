import assert from "node:assert";
import { test } from "node:test";
import { hashDeviceId } from "@floorsense/shared";
import type { CalibrationProfile } from "@floorsense/positioning";
import { openDatabase } from "./db.ts";
import { createOwner, createVenue, createApNode } from "./tenancy.ts";
import { recordConsentGrant } from "./consent.ts";
import { ingestApEvent } from "./ingest.ts";
import { DEFAULT_CALIBRATION_PROFILE } from "./calibration.ts";
import { estimateCurrentPosition } from "./positioning.ts";

function rssiAtDistance(distance: number, profile: CalibrationProfile): number {
  return profile.referenceRssiAt1m - 10 * profile.pathLossExponent * Math.log10(Math.max(distance, 0.1));
}

function setupVenueWithTriangle(db: ReturnType<typeof openDatabase>) {
  const owner = createOwner(db, "Positioning Test Owner");
  const venue = createVenue(db, owner.id, { name: "Positioning Test Venue", floorWidth: 20, floorHeight: 15 });
  const apNodes = [
    createApNode(db, venue.id, { apNodeId: "ap-1", x: 0, y: 0 }),
    createApNode(db, venue.id, { apNodeId: "ap-2", x: 10, y: 0 }),
    createApNode(db, venue.id, { apNodeId: "ap-3", x: 5, y: 10 }),
  ];
  return { tenantId: owner.id, venueId: venue.id, apNodes };
}

function ingestSignalReading(
  db: ReturnType<typeof openDatabase>,
  args: { tenantId: string; venueId: string; apNodeId: string; hashedDeviceId: string; rssi: number; timestamp: number }
) {
  const result = ingestApEvent(db, {
    type: "signal_reading",
    hashedDeviceId: args.hashedDeviceId,
    tenantId: args.tenantId,
    venueId: args.venueId,
    apNodeId: args.apNodeId,
    timestamp: args.timestamp,
    rssi: args.rssi,
  });
  assert.strictEqual(result.accepted, true, "test setup expects the ingest to succeed");
}

test("estimateCurrentPosition trilaterates from a device's most recent readings across 3 AP nodes", () => {
  const db = openDatabase(":memory:");
  const { tenantId, venueId, apNodes } = setupVenueWithTriangle(db);
  const hashedDeviceId = hashDeviceId("aa:bb:cc:dd:ee:ff", "test-salt");
  recordConsentGrant(db, { tenantId, venueId, hashedDeviceId, termsVersion: "v1" });

  const truth = { x: 5, y: 3 };
  for (const node of apNodes) {
    ingestSignalReading(db, {
      tenantId,
      venueId,
      apNodeId: node.apNodeId,
      hashedDeviceId,
      rssi: rssiAtDistance(Math.hypot(truth.x - node.x, truth.y - node.y), DEFAULT_CALIBRATION_PROFILE),
      timestamp: 1000,
    });
  }

  const estimate = estimateCurrentPosition(db, tenantId, venueId, hashedDeviceId);
  assert.strictEqual(estimate.confidence, "trilaterated");
  assert.ok(estimate.confidence === "trilaterated");
  assert.ok(Math.abs(estimate.x - truth.x) < 0.01);
  assert.ok(Math.abs(estimate.y - truth.y) < 0.01);
  db.close();
});

test("estimateCurrentPosition uses each AP node's most recent reading, not a stale earlier one", () => {
  const db = openDatabase(":memory:");
  const { tenantId, venueId, apNodes } = setupVenueWithTriangle(db);
  const hashedDeviceId = hashDeviceId("aa:bb:cc:dd:ee:ff", "test-salt");
  recordConsentGrant(db, { tenantId, venueId, hashedDeviceId, termsVersion: "v1" });

  const stale = { x: 1, y: 1 };
  const current = { x: 5, y: 3 };

  // Stale readings recorded earlier, all at timestamp 1000.
  for (const node of apNodes) {
    ingestSignalReading(db, {
      tenantId,
      venueId,
      apNodeId: node.apNodeId,
      hashedDeviceId,
      rssi: rssiAtDistance(Math.hypot(stale.x - node.x, stale.y - node.y), DEFAULT_CALIBRATION_PROFILE),
      timestamp: 1000,
    });
  }
  // Current readings recorded later, at timestamp 2000.
  for (const node of apNodes) {
    ingestSignalReading(db, {
      tenantId,
      venueId,
      apNodeId: node.apNodeId,
      hashedDeviceId,
      rssi: rssiAtDistance(Math.hypot(current.x - node.x, current.y - node.y), DEFAULT_CALIBRATION_PROFILE),
      timestamp: 2000,
    });
  }

  const estimate = estimateCurrentPosition(db, tenantId, venueId, hashedDeviceId);
  assert.strictEqual(estimate.confidence, "trilaterated");
  assert.ok(estimate.confidence === "trilaterated");
  assert.ok(Math.abs(estimate.x - current.x) < 0.01, `expected the later reading's x (${current.x}), got ${estimate.x}`);
  assert.ok(Math.abs(estimate.y - current.y) < 0.01, `expected the later reading's y (${current.y}), got ${estimate.y}`);
  db.close();
});

test("a device with no recent readings returns an explicit no-data result, not a crash", () => {
  const db = openDatabase(":memory:");
  const { tenantId, venueId } = setupVenueWithTriangle(db);
  const hashedDeviceId = hashDeviceId("aa:bb:cc:dd:ee:ff", "test-salt");

  const estimate = estimateCurrentPosition(db, tenantId, venueId, hashedDeviceId);
  assert.strictEqual(estimate.confidence, "no-data");
  db.close();
});

test("tenant isolation: owner B cannot obtain a position estimate using owner A's tenantId/venueId combination", () => {
  const db = openDatabase(":memory:");
  const { tenantId: tenantA, venueId: venueA, apNodes } = setupVenueWithTriangle(db);
  const ownerB = createOwner(db, "Owner B");
  const hashedDeviceId = hashDeviceId("aa:bb:cc:dd:ee:ff", "test-salt");
  recordConsentGrant(db, { tenantId: tenantA, venueId: venueA, hashedDeviceId, termsVersion: "v1" });

  for (const node of apNodes) {
    ingestSignalReading(db, {
      tenantId: tenantA,
      venueId: venueA,
      apNodeId: node.apNodeId,
      hashedDeviceId,
      rssi: rssiAtDistance(Math.hypot(5 - node.x, 3 - node.y), DEFAULT_CALIBRATION_PROFILE),
      timestamp: 1000,
    });
  }

  // Real events exist for tenantA/venueA/hashedDeviceId, but owner B's own id combined
  // with venue A's id must not surface them.
  const estimate = estimateCurrentPosition(db, ownerB.id, venueA, hashedDeviceId);
  assert.strictEqual(estimate.confidence, "no-data");

  const legitEstimate = estimateCurrentPosition(db, tenantA, venueA, hashedDeviceId);
  assert.strictEqual(legitEstimate.confidence, "trilaterated");
  db.close();
});

import assert from "node:assert";
import { test } from "node:test";
import { hashDeviceId } from "@floorsense/shared";
import type { DeviceSession } from "./sessions.ts";
import { openDatabase } from "./db.ts";
import { createOwner, createVenue } from "./tenancy.ts";
import { recordConsentGrant } from "./consent.ts";
import { ingestApEvent } from "./ingest.ts";
import { SESSION_GAP_MS, mergeSessionsIntoVisits, computeReturnVisitStats } from "./returnVisits.ts";

function mkSession(overrides: Partial<DeviceSession> & Pick<DeviceSession, "joinedAt" | "leftAt">): DeviceSession {
  return {
    hashedDeviceId: "device-1",
    venueId: "venue-1",
    dwellTimeMs: overrides.leftAt !== null ? overrides.leftAt - overrides.joinedAt : null,
    ...overrides,
  };
}

test("a gap just below SESSION_GAP_MS merges two sessions into one visit", () => {
  const sessions = [
    mkSession({ joinedAt: 0, leftAt: 1000 }),
    mkSession({ joinedAt: 1000 + SESSION_GAP_MS - 1, leftAt: 1000 + SESSION_GAP_MS - 1 + 2000 }),
  ];

  const visits = mergeSessionsIntoVisits(sessions);
  assert.strictEqual(visits.length, 1, "a gap just under the threshold must merge into a single visit");
  assert.strictEqual(visits[0]?.joinedAt, 0);
  assert.strictEqual(visits[0]?.dwellTimeMs, 3000, "merged dwell time must be the sum of both sessions' dwell times");
});

test("a gap exactly equal to SESSION_GAP_MS does not merge (the boundary is exclusive)", () => {
  const sessions = [
    mkSession({ joinedAt: 0, leftAt: 1000 }),
    mkSession({ joinedAt: 1000 + SESSION_GAP_MS, leftAt: 1000 + SESSION_GAP_MS + 2000 }),
  ];

  const visits = mergeSessionsIntoVisits(sessions);
  assert.strictEqual(visits.length, 2, "a gap exactly at the threshold must count as a separate visit");
});

test("a gap well above SESSION_GAP_MS does not merge", () => {
  const sessions = [
    mkSession({ joinedAt: 0, leftAt: 1000 }),
    mkSession({ joinedAt: 1000 + SESSION_GAP_MS + 60_000, leftAt: 1000 + SESSION_GAP_MS + 62_000 }),
  ];

  const visits = mergeSessionsIntoVisits(sessions);
  assert.strictEqual(visits.length, 2);
});

test("an ongoing (leftAt: null) session never merges with what follows it", () => {
  const sessions = [
    mkSession({ joinedAt: 0, leftAt: null }),
    mkSession({ joinedAt: 500, leftAt: 1500 }),
  ];

  const visits = mergeSessionsIntoVisits(sessions);
  assert.strictEqual(visits.length, 2, "an unknown end time means no gap can be measured, so no merge is possible");
  assert.strictEqual(visits[0]?.leftAt, null);
});

test("computeReturnVisitStats: a single-visit device is classified as new, not returning", () => {
  const db = openDatabase(":memory:");
  const owner = createOwner(db, "Return Visit Test Owner");
  const venue = createVenue(db, owner.id, { name: "Return Visit Test Venue", floorWidth: 10, floorHeight: 8 });
  const hashedDeviceId = hashDeviceId("aa:bb:cc:dd:ee:ff", "test-salt");
  recordConsentGrant(db, { tenantId: owner.id, venueId: venue.id, hashedDeviceId, termsVersion: "v1" });

  ingestApEvent(db, { type: "join", hashedDeviceId, tenantId: owner.id, venueId: venue.id, apNodeId: "ap-1", timestamp: 1000 });
  ingestApEvent(db, { type: "leave", hashedDeviceId, tenantId: owner.id, venueId: venue.id, apNodeId: "ap-1", timestamp: 4000 });

  const stats = computeReturnVisitStats(db, owner.id, venue.id);
  assert.strictEqual(stats.perDevice.length, 1);
  assert.strictEqual(stats.perDevice[0]?.visitCount, 1);
  assert.strictEqual(stats.perDevice[0]?.isReturning, false);
  assert.strictEqual(stats.newDeviceCount, 1);
  assert.strictEqual(stats.returningDeviceCount, 0);
  assert.strictEqual(stats.returningRatio, 0);
  db.close();
});

test("computeReturnVisitStats: a device with two visits separated by a real gap is classified as returning", () => {
  const db = openDatabase(":memory:");
  const owner = createOwner(db, "Return Visit Test Owner");
  const venue = createVenue(db, owner.id, { name: "Return Visit Test Venue", floorWidth: 10, floorHeight: 8 });
  const hashedDeviceId = hashDeviceId("aa:bb:cc:dd:ee:ff", "test-salt");
  recordConsentGrant(db, { tenantId: owner.id, venueId: venue.id, hashedDeviceId, termsVersion: "v1" });

  ingestApEvent(db, { type: "join", hashedDeviceId, tenantId: owner.id, venueId: venue.id, apNodeId: "ap-1", timestamp: 1000 });
  ingestApEvent(db, { type: "leave", hashedDeviceId, tenantId: owner.id, venueId: venue.id, apNodeId: "ap-1", timestamp: 4000 });

  const secondVisitStart = 4000 + SESSION_GAP_MS + 60_000;
  ingestApEvent(db, { type: "join", hashedDeviceId, tenantId: owner.id, venueId: venue.id, apNodeId: "ap-1", timestamp: secondVisitStart });
  ingestApEvent(db, {
    type: "leave",
    hashedDeviceId,
    tenantId: owner.id,
    venueId: venue.id,
    apNodeId: "ap-1",
    timestamp: secondVisitStart + 5000,
  });

  const stats = computeReturnVisitStats(db, owner.id, venue.id);
  assert.strictEqual(stats.perDevice.length, 1);
  assert.strictEqual(stats.perDevice[0]?.visitCount, 2);
  assert.strictEqual(stats.perDevice[0]?.isReturning, true);
  assert.strictEqual(stats.perDevice[0]?.averageDwellTimeMs, 4000, "average of a 3000ms visit and a 5000ms visit");
  assert.strictEqual(stats.newDeviceCount, 0);
  assert.strictEqual(stats.returningDeviceCount, 1);
  assert.strictEqual(stats.returningRatio, 1);
  db.close();
});

test("computeReturnVisitStats: venue-level aggregates across multiple devices", () => {
  const db = openDatabase(":memory:");
  const owner = createOwner(db, "Aggregate Test Owner");
  const venue = createVenue(db, owner.id, { name: "Aggregate Test Venue", floorWidth: 10, floorHeight: 8 });

  const returningDevice = hashDeviceId("aa:aa:aa:aa:aa:aa", "test-salt");
  const newDevice = hashDeviceId("bb:bb:bb:bb:bb:bb", "test-salt");
  recordConsentGrant(db, { tenantId: owner.id, venueId: venue.id, hashedDeviceId: returningDevice, termsVersion: "v1" });
  recordConsentGrant(db, { tenantId: owner.id, venueId: venue.id, hashedDeviceId: newDevice, termsVersion: "v1" });

  // Returning device: two visits with a real gap between them.
  ingestApEvent(db, { type: "join", hashedDeviceId: returningDevice, tenantId: owner.id, venueId: venue.id, apNodeId: "ap-1", timestamp: 1000 });
  ingestApEvent(db, { type: "leave", hashedDeviceId: returningDevice, tenantId: owner.id, venueId: venue.id, apNodeId: "ap-1", timestamp: 2000 });
  const secondStart = 2000 + SESSION_GAP_MS + 1000;
  ingestApEvent(db, { type: "join", hashedDeviceId: returningDevice, tenantId: owner.id, venueId: venue.id, apNodeId: "ap-1", timestamp: secondStart });
  ingestApEvent(db, { type: "leave", hashedDeviceId: returningDevice, tenantId: owner.id, venueId: venue.id, apNodeId: "ap-1", timestamp: secondStart + 1000 });

  // New device: one visit only.
  ingestApEvent(db, { type: "join", hashedDeviceId: newDevice, tenantId: owner.id, venueId: venue.id, apNodeId: "ap-1", timestamp: 1500 });
  ingestApEvent(db, { type: "leave", hashedDeviceId: newDevice, tenantId: owner.id, venueId: venue.id, apNodeId: "ap-1", timestamp: 1800 });

  const stats = computeReturnVisitStats(db, owner.id, venue.id);
  assert.strictEqual(stats.perDevice.length, 2);
  assert.strictEqual(stats.newDeviceCount, 1);
  assert.strictEqual(stats.returningDeviceCount, 1);
  assert.strictEqual(stats.returningRatio, 0.5);
  db.close();
});

test("computeReturnVisitStats: hourOfDayDistribution buckets a visit's start by UTC hour", () => {
  const db = openDatabase(":memory:");
  const owner = createOwner(db, "Hour Bucket Test Owner");
  const venue = createVenue(db, owner.id, { name: "Hour Bucket Test Venue", floorWidth: 10, floorHeight: 8 });
  const hashedDeviceId = hashDeviceId("aa:bb:cc:dd:ee:ff", "test-salt");
  recordConsentGrant(db, { tenantId: owner.id, venueId: venue.id, hashedDeviceId, termsVersion: "v1" });

  const joinedAt = Date.UTC(2026, 0, 1, 14, 30, 0); // 14:30 UTC
  ingestApEvent(db, { type: "join", hashedDeviceId, tenantId: owner.id, venueId: venue.id, apNodeId: "ap-1", timestamp: joinedAt });
  ingestApEvent(db, { type: "leave", hashedDeviceId, tenantId: owner.id, venueId: venue.id, apNodeId: "ap-1", timestamp: joinedAt + 1000 });

  const stats = computeReturnVisitStats(db, owner.id, venue.id);
  assert.strictEqual(stats.hourOfDayDistribution.length, 24);
  assert.strictEqual(stats.hourOfDayDistribution[14], 1);
  assert.strictEqual(stats.hourOfDayDistribution.reduce((a, b) => a + b, 0), 1);
  db.close();
});

test("computeReturnVisitStats is tenant-isolated: owner A's stats never include owner B's events for a shared hashedDeviceId", () => {
  const db = openDatabase(":memory:");
  const ownerA = createOwner(db, "Owner A");
  const venueA = createVenue(db, ownerA.id, { name: "Venue A", floorWidth: 10, floorHeight: 8 });
  const ownerB = createOwner(db, "Owner B");
  const venueB = createVenue(db, ownerB.id, { name: "Venue B", floorWidth: 10, floorHeight: 8 });

  const hashedDeviceId = hashDeviceId("aa:bb:cc:dd:ee:ff", "test-salt");
  recordConsentGrant(db, { tenantId: ownerA.id, venueId: venueA.id, hashedDeviceId, termsVersion: "v1" });
  recordConsentGrant(db, { tenantId: ownerB.id, venueId: venueB.id, hashedDeviceId, termsVersion: "v1" });

  // Owner A: two visits (returning). Owner B: one visit (new).
  ingestApEvent(db, { type: "join", hashedDeviceId, tenantId: ownerA.id, venueId: venueA.id, apNodeId: "ap-1", timestamp: 1000 });
  ingestApEvent(db, { type: "leave", hashedDeviceId, tenantId: ownerA.id, venueId: venueA.id, apNodeId: "ap-1", timestamp: 2000 });
  const secondStart = 2000 + SESSION_GAP_MS + 1000;
  ingestApEvent(db, { type: "join", hashedDeviceId, tenantId: ownerA.id, venueId: venueA.id, apNodeId: "ap-1", timestamp: secondStart });
  ingestApEvent(db, { type: "leave", hashedDeviceId, tenantId: ownerA.id, venueId: venueA.id, apNodeId: "ap-1", timestamp: secondStart + 1000 });

  ingestApEvent(db, { type: "join", hashedDeviceId, tenantId: ownerB.id, venueId: venueB.id, apNodeId: "ap-1", timestamp: 1500 });
  ingestApEvent(db, { type: "leave", hashedDeviceId, tenantId: ownerB.id, venueId: venueB.id, apNodeId: "ap-1", timestamp: 1800 });

  const statsA = computeReturnVisitStats(db, ownerA.id, venueA.id);
  const statsB = computeReturnVisitStats(db, ownerB.id, venueB.id);

  assert.strictEqual(statsA.perDevice[0]?.visitCount, 2, "owner A must see both of their own device's visits, not owner B's");
  assert.strictEqual(statsA.perDevice[0]?.isReturning, true);
  assert.strictEqual(statsB.perDevice[0]?.visitCount, 1, "owner B must not see owner A's visits for the same hashedDeviceId");
  assert.strictEqual(statsB.perDevice[0]?.isReturning, false);
  db.close();
});

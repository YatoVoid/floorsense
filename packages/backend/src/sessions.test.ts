import assert from "node:assert";
import { test } from "node:test";
import { hashDeviceId } from "@floorsense/shared";
import type { StoredApEvent } from "./ingest.ts";
import { openDatabase } from "./db.ts";
import { createOwner, createVenue } from "./tenancy.ts";
import { recordConsentGrant } from "./consent.ts";
import { ingestApEvent } from "./ingest.ts";
import { reconstructSessions, getSessionsForVenue, getSessionsForDevice } from "./sessions.ts";

let nextId = 1;
function mkEvent(overrides: Partial<StoredApEvent> & Pick<StoredApEvent, "eventType" | "timestamp">): StoredApEvent {
  return {
    id: nextId++,
    tenantId: "tenant-1",
    venueId: "venue-1",
    apNodeId: "ap-1",
    hashedDeviceId: "device-1",
    rssi: null,
    ...overrides,
  };
}

test("a simple join/leave pair produces one session with correct dwell time", () => {
  const events = [
    mkEvent({ eventType: "join", timestamp: 1000 }),
    mkEvent({ eventType: "leave", timestamp: 5000 }),
  ];

  const sessions = reconstructSessions(events);
  assert.strictEqual(sessions.length, 1);
  assert.strictEqual(sessions[0]?.joinedAt, 1000);
  assert.strictEqual(sessions[0]?.leftAt, 5000);
  assert.strictEqual(sessions[0]?.dwellTimeMs, 4000);
});

test("a dangling leave (no preceding open join) is skipped, not fabricated into a session", () => {
  const events = [
    mkEvent({ eventType: "leave", timestamp: 500 }),
    mkEvent({ eventType: "join", timestamp: 1000 }),
    mkEvent({ eventType: "leave", timestamp: 3000 }),
  ];

  const sessions = reconstructSessions(events);
  assert.strictEqual(sessions.length, 1, "the dangling leave at t=500 must not produce a session");
  assert.strictEqual(sessions[0]?.joinedAt, 1000);
  assert.strictEqual(sessions[0]?.leftAt, 3000);
});

test("a dangling leave for one device does not affect session reconstruction for other devices", () => {
  const events = [
    mkEvent({ eventType: "leave", timestamp: 500, hashedDeviceId: "device-1" }),
    mkEvent({ eventType: "join", timestamp: 1000, hashedDeviceId: "device-2" }),
    mkEvent({ eventType: "leave", timestamp: 2000, hashedDeviceId: "device-2" }),
  ];

  const sessions = reconstructSessions(events);
  assert.strictEqual(sessions.length, 1);
  assert.strictEqual(sessions[0]?.hashedDeviceId, "device-2");
});

test("an ongoing join with no leave yet produces a session with leftAt/dwellTimeMs both null", () => {
  const events = [mkEvent({ eventType: "join", timestamp: 1000 })];

  const sessions = reconstructSessions(events);
  assert.strictEqual(sessions.length, 1);
  assert.strictEqual(sessions[0]?.joinedAt, 1000);
  assert.strictEqual(sessions[0]?.leftAt, null);
  assert.strictEqual(sessions[0]?.dwellTimeMs, null);
});

test("a second join while one is already open closes the first as ongoing (leftAt null) rather than dropping it", () => {
  const events = [
    mkEvent({ eventType: "join", timestamp: 1000 }),
    mkEvent({ eventType: "join", timestamp: 2000 }),
    mkEvent({ eventType: "leave", timestamp: 3000 }),
  ];

  const sessions = reconstructSessions(events);
  assert.strictEqual(sessions.length, 2);
  assert.strictEqual(sessions[0]?.joinedAt, 1000);
  assert.strictEqual(sessions[0]?.leftAt, null);
  assert.strictEqual(sessions[1]?.joinedAt, 2000);
  assert.strictEqual(sessions[1]?.leftAt, 3000);
});

test("out-of-order timestamps produce the same result as sorted input", () => {
  const sortedEvents = [
    mkEvent({ eventType: "join", timestamp: 1000 }),
    mkEvent({ eventType: "leave", timestamp: 2000 }),
    mkEvent({ eventType: "join", timestamp: 3000 }),
    mkEvent({ eventType: "leave", timestamp: 4000 }),
  ];
  const shuffledEvents = [sortedEvents[2]!, sortedEvents[0]!, sortedEvents[3]!, sortedEvents[1]!];

  const fromSorted = reconstructSessions(sortedEvents);
  const fromShuffled = reconstructSessions(shuffledEvents);
  assert.deepStrictEqual(fromShuffled, fromSorted);
  assert.strictEqual(fromSorted.length, 2);
});

test("signal_reading events are ignored for pairing purposes", () => {
  const events = [
    mkEvent({ eventType: "join", timestamp: 1000 }),
    mkEvent({ eventType: "signal_reading", timestamp: 1500, rssi: -60 }),
    mkEvent({ eventType: "signal_reading", timestamp: 2000, rssi: -58 }),
    mkEvent({ eventType: "leave", timestamp: 2500 }),
  ];

  const sessions = reconstructSessions(events);
  assert.strictEqual(sessions.length, 1);
  assert.strictEqual(sessions[0]?.dwellTimeMs, 1500);
});

test("multiple devices interleaved in one venue do not cross-pair each other's joins/leaves", () => {
  const events = [
    mkEvent({ eventType: "join", timestamp: 1000, hashedDeviceId: "device-A" }),
    mkEvent({ eventType: "join", timestamp: 1100, hashedDeviceId: "device-B" }),
    mkEvent({ eventType: "leave", timestamp: 2000, hashedDeviceId: "device-A" }),
    mkEvent({ eventType: "leave", timestamp: 2200, hashedDeviceId: "device-B" }),
  ];

  const sessions = reconstructSessions(events);
  assert.strictEqual(sessions.length, 2);
  const byDevice = new Map(sessions.map((s) => [s.hashedDeviceId, s]));
  assert.strictEqual(byDevice.get("device-A")?.dwellTimeMs, 1000);
  assert.strictEqual(byDevice.get("device-B")?.dwellTimeMs, 1100);
});

test("the same hashedDeviceId at two different venues is tracked as two independent session sets", () => {
  const events = [
    mkEvent({ eventType: "join", timestamp: 1000, venueId: "venue-A" }),
    mkEvent({ eventType: "leave", timestamp: 2000, venueId: "venue-A" }),
    mkEvent({ eventType: "join", timestamp: 1500, venueId: "venue-B" }),
    mkEvent({ eventType: "leave", timestamp: 2500, venueId: "venue-B" }),
  ];

  const sessions = reconstructSessions(events);
  assert.strictEqual(sessions.length, 2);
  const byVenue = new Map(sessions.map((s) => [s.venueId, s]));
  assert.strictEqual(byVenue.get("venue-A")?.leftAt, 2000);
  assert.strictEqual(byVenue.get("venue-B")?.leftAt, 2500);
});

test("getSessionsForVenue/getSessionsForDevice round-trip through the real database, tenant-scoped", () => {
  const db = openDatabase(":memory:");
  const ownerA = createOwner(db, "Sessions Test Owner A");
  const venueA = createVenue(db, ownerA.id, { name: "Venue A", floorWidth: 10, floorHeight: 8 });
  const ownerB = createOwner(db, "Sessions Test Owner B");
  const venueB = createVenue(db, ownerB.id, { name: "Venue B", floorWidth: 10, floorHeight: 8 });

  const hashedDeviceId = hashDeviceId("aa:bb:cc:dd:ee:ff", "test-salt");
  recordConsentGrant(db, { tenantId: ownerA.id, venueId: venueA.id, hashedDeviceId, termsVersion: "v1" });
  recordConsentGrant(db, { tenantId: ownerB.id, venueId: venueB.id, hashedDeviceId, termsVersion: "v1" });

  for (const [tenantId, venueId] of [
    [ownerA.id, venueA.id],
    [ownerB.id, venueB.id],
  ] as const) {
    ingestApEvent(db, { type: "join", hashedDeviceId, tenantId, venueId, apNodeId: "ap-1", timestamp: 1000 });
    ingestApEvent(db, { type: "leave", hashedDeviceId, tenantId, venueId, apNodeId: "ap-1", timestamp: 4000 });
  }

  const sessionsA = getSessionsForVenue(db, ownerA.id, venueA.id);
  assert.strictEqual(sessionsA.length, 1);
  assert.strictEqual(sessionsA[0]?.dwellTimeMs, 3000);

  const sessionsForDeviceA = getSessionsForDevice(db, ownerA.id, venueA.id, hashedDeviceId);
  assert.strictEqual(sessionsForDeviceA.length, 1);

  // Owner B's own tenantId/venueId combination must not surface owner A's session, even for the same hashedDeviceId.
  const crossTenant = getSessionsForVenue(db, ownerB.id, venueA.id);
  assert.strictEqual(crossTenant.length, 0);
  db.close();
});

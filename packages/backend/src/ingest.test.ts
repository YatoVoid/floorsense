import assert from "node:assert";
import { test } from "node:test";
import { hashDeviceId } from "@floorsense/shared";
import { openDatabase } from "./db.ts";
import { createOwner, createVenue } from "./tenancy.ts";
import { ingestApEvent, getEventsForVenue } from "./ingest.ts";

function setupTenant(db: ReturnType<typeof openDatabase>) {
  const owner = createOwner(db, "Test Owner");
  const venue = createVenue(db, owner.id, { name: "Test Venue", floorWidth: 10, floorHeight: 8 });
  return { ownerId: owner.id, venueId: venue.id };
}

test("a valid signal_reading event round-trips through ingest and read-back", () => {
  const db = openDatabase(":memory:");
  const { ownerId, venueId } = setupTenant(db);
  const hashedDeviceId = hashDeviceId("aa:bb:cc:dd:ee:ff", "test-salt");

  const accepted = ingestApEvent(db, {
    type: "signal_reading",
    hashedDeviceId,
    tenantId: ownerId,
    venueId,
    apNodeId: "ap-1",
    timestamp: 1000,
    rssi: -55,
  });
  assert.strictEqual(accepted, true);

  const events = getEventsForVenue(db, ownerId, venueId);
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0]?.eventType, "signal_reading");
  assert.strictEqual(events[0]?.rssi, -55);
  assert.strictEqual(events[0]?.hashedDeviceId, hashedDeviceId);
  db.close();
});

test("a valid join event round-trips with a null rssi", () => {
  const db = openDatabase(":memory:");
  const { ownerId, venueId } = setupTenant(db);
  const hashedDeviceId = hashDeviceId("aa:bb:cc:dd:ee:ff", "test-salt");

  ingestApEvent(db, {
    type: "join",
    hashedDeviceId,
    tenantId: ownerId,
    venueId,
    apNodeId: "ap-1",
    timestamp: 1000,
  });

  const events = getEventsForVenue(db, ownerId, venueId);
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0]?.eventType, "join");
  assert.strictEqual(events[0]?.rssi, null);
  db.close();
});

test("an invalid event is rejected, not silently stored", () => {
  const db = openDatabase(":memory:");
  const { ownerId, venueId } = setupTenant(db);

  const accepted = ingestApEvent(db, {
    type: "signal_reading",
    // missing hashedDeviceId entirely
    tenantId: ownerId,
    venueId,
    apNodeId: "ap-1",
    timestamp: 1000,
    rssi: -55,
  });
  assert.strictEqual(accepted, false);

  const events = getEventsForVenue(db, ownerId, venueId);
  assert.strictEqual(events.length, 0, "a rejected event must not appear in storage");
  db.close();
});

test("events are tenant-isolated: owner A cannot read owner B's events", () => {
  const db = openDatabase(":memory:");
  const ownerA = createOwner(db, "Owner A");
  const venueA = createVenue(db, ownerA.id, { name: "Venue A", floorWidth: 10, floorHeight: 8 });
  const ownerB = createOwner(db, "Owner B");
  const venueB = createVenue(db, ownerB.id, { name: "Venue B", floorWidth: 10, floorHeight: 8 });

  const hashedDeviceId = hashDeviceId("aa:bb:cc:dd:ee:ff", "test-salt");
  ingestApEvent(db, {
    type: "join",
    hashedDeviceId,
    tenantId: ownerA.id,
    venueId: venueA.id,
    apNodeId: "ap-1",
    timestamp: 1000,
  });

  const eventsForB = getEventsForVenue(db, ownerB.id, venueA.id);
  assert.strictEqual(eventsForB.length, 0, "owner B must not see owner A's event even if they somehow knew venue A's id");

  const eventsForA = getEventsForVenue(db, ownerA.id, venueA.id);
  assert.strictEqual(eventsForA.length, 1);
  db.close();
});

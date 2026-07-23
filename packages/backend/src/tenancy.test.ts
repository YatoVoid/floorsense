import assert from "node:assert";
import { test } from "node:test";
import { openDatabase } from "./db.ts";
import { createOwner, createVenue, createApNode, getVenuesForOwner, getApNodesForVenue } from "./tenancy.ts";

test("createOwner/createVenue round-trip and getVenuesForOwner returns them", () => {
  const db = openDatabase(":memory:");
  const owner = createOwner(db, "Test Owner");
  const venue = createVenue(db, owner.id, { name: "Test Venue", floorWidth: 10, floorHeight: 8 });

  const venues = getVenuesForOwner(db, owner.id);
  assert.strictEqual(venues.length, 1);
  assert.strictEqual(venues[0]?.id, venue.id);
  assert.strictEqual(venues[0]?.name, "Test Venue");
  db.close();
});

test("tenant isolation: owner A never sees owner B's venues", () => {
  const db = openDatabase(":memory:");
  const ownerA = createOwner(db, "Owner A");
  const ownerB = createOwner(db, "Owner B");
  createVenue(db, ownerA.id, { name: "Venue A", floorWidth: 10, floorHeight: 8 });
  createVenue(db, ownerB.id, { name: "Venue B", floorWidth: 12, floorHeight: 9 });

  const venuesForA = getVenuesForOwner(db, ownerA.id);
  const venuesForB = getVenuesForOwner(db, ownerB.id);

  assert.strictEqual(venuesForA.length, 1);
  assert.strictEqual(venuesForA[0]?.name, "Venue A");
  assert.strictEqual(venuesForB.length, 1);
  assert.strictEqual(venuesForB[0]?.name, "Venue B");
  db.close();
});

test("tenant isolation: getApNodesForVenue requires the correct owner AND venue", () => {
  const db = openDatabase(":memory:");
  const ownerA = createOwner(db, "Owner A");
  const ownerB = createOwner(db, "Owner B");
  const venueA = createVenue(db, ownerA.id, { name: "Venue A", floorWidth: 10, floorHeight: 8 });
  createApNode(db, venueA.id, { apNodeId: "ap-1", x: 1, y: 1 });

  // Owner B querying venue A's AP nodes (even knowing its id) must get nothing.
  const nodesForWrongOwner = getApNodesForVenue(db, ownerB.id, venueA.id);
  assert.strictEqual(nodesForWrongOwner.length, 0);

  const nodesForCorrectOwner = getApNodesForVenue(db, ownerA.id, venueA.id);
  assert.strictEqual(nodesForCorrectOwner.length, 1);
  assert.strictEqual(nodesForCorrectOwner[0]?.apNodeId, "ap-1");
  db.close();
});

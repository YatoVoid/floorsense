import assert from "node:assert";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { hashDeviceId } from "@floorsense/shared";
import {
  openDatabase,
  createOwnerWithPassword,
  createOwner,
  createVenue,
  createApNode,
  createSession,
  recordConsentGrant,
  ingestApEvent,
  computeVenueHeatmap,
  computeReturnVisitStats,
  setOwnerTier,
} from "@floorsense/backend";
import { createOwnerPortalServer } from "./server.ts";

async function withServer(db: ReturnType<typeof openDatabase>, fn: (baseUrl: string) => Promise<void>) {
  const server = createOwnerPortalServer(db);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("GET / serves the dashboard page as HTML containing the login form", async () => {
  const db = openDatabase(":memory:");
  await withServer(db, async (baseUrl) => {
    const res = await fetch(baseUrl);
    assert.strictEqual(res.status, 200);
    assert.ok(res.headers.get("content-type")?.includes("text/html"));
    const html = await res.text();
    assert.match(html, /<form id="login-form">/);
  });
  db.close();
});

test("POST /auth/login with correct credentials returns a usable token", async () => {
  const db = openDatabase(":memory:");
  createOwnerWithPassword(db, "Login Test Owner", "correct-password");

  await withServer(db, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Login Test Owner", password: "correct-password" }),
    });
    assert.strictEqual(res.status, 200);
    const json = (await res.json()) as { token: string };
    assert.strictEqual(typeof json.token, "string");
    assert.ok(json.token.length > 0);
  });
  db.close();
});

test("POST /auth/login: unknown owner and wrong password produce byte-identical failure responses", async () => {
  const db = openDatabase(":memory:");
  createOwnerWithPassword(db, "Response Parity Owner", "the-real-password");

  await withServer(db, async (baseUrl) => {
    const wrongPasswordRes = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Response Parity Owner", password: "wrong" }),
    });
    const unknownOwnerRes = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Nobody Registered", password: "wrong" }),
    });

    assert.strictEqual(wrongPasswordRes.status, unknownOwnerRes.status);
    const [wrongBody, unknownBody] = await Promise.all([wrongPasswordRes.text(), unknownOwnerRes.text()]);
    assert.strictEqual(wrongBody, unknownBody, "the two failure responses must be byte-identical — no information leak");
  });
  db.close();
});

test("POST /auth/register creates a real owner and returns an immediately-usable session token", async () => {
  const db = openDatabase(":memory:");
  await withServer(db, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Brand New Owner", password: "a-real-password" }),
    });
    assert.strictEqual(res.status, 201);
    const { token } = (await res.json()) as { token: string };
    assert.ok(token.length > 0);

    const venuesRes = await fetch(`${baseUrl}/venues`, { headers: { Authorization: `Bearer ${token}` } });
    assert.strictEqual(venuesRes.status, 200, "the freshly issued token must work immediately, not just look valid");
    const venues = await venuesRes.json();
    assert.deepStrictEqual(venues, [], "a brand-new owner starts with zero venues");
  });
  db.close();
});

test("POST /auth/register rejects a duplicate name with 409, not a silent overwrite or a 500", async () => {
  const db = openDatabase(":memory:");
  createOwnerWithPassword(db, "Existing Owner", "first-password");

  await withServer(db, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Existing Owner", password: "second-password" }),
    });
    assert.strictEqual(res.status, 409);
  });

  const rows = db.prepare("SELECT id FROM owners WHERE name = ?").all("Existing Owner");
  assert.strictEqual(rows.length, 1, "the duplicate registration attempt must not create a second row");
  db.close();
});

test("POST /auth/register rejects a malformed body with 400", async () => {
  const db = openDatabase(":memory:");
  await withServer(db, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Missing Password Owner" }),
    });
    assert.strictEqual(res.status, 400);
  });
  db.close();
});

test("POST /venues rejects a request with no token", async () => {
  const db = openDatabase(":memory:");
  await withServer(db, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/venues`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Unauthorized Venue", floorWidth: 10, floorHeight: 8 }),
    });
    assert.strictEqual(res.status, 401);
  });
  db.close();
});

test("POST /venues creates a real venue scoped to the authenticated owner, invisible to a different owner", async () => {
  const db = openDatabase(":memory:");
  const owner = createOwnerWithPassword(db, "Venue Creator Owner", "password");
  const otherOwner = createOwnerWithPassword(db, "Other Owner", "password");
  const token = createSession(db, owner.id, Date.now(), 60_000);
  const otherToken = createSession(db, otherOwner.id, Date.now(), 60_000);

  await withServer(db, async (baseUrl) => {
    const createRes = await fetch(`${baseUrl}/venues`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: "My First Venue", floorWidth: 12, floorHeight: 9 }),
    });
    assert.strictEqual(createRes.status, 201);
    const created = (await createRes.json()) as { id: string; name: string };
    assert.strictEqual(created.name, "My First Venue");

    const ownVenuesRes = await fetch(`${baseUrl}/venues`, { headers: { Authorization: `Bearer ${token}` } });
    const ownVenues = (await ownVenuesRes.json()) as Array<{ id: string }>;
    assert.strictEqual(ownVenues.length, 1);
    assert.strictEqual(ownVenues[0]?.id, created.id);

    const otherVenuesRes = await fetch(`${baseUrl}/venues`, { headers: { Authorization: `Bearer ${otherToken}` } });
    const otherVenues = await otherVenuesRes.json();
    assert.deepStrictEqual(otherVenues, [], "a different owner must never see the created venue");
  });
  db.close();
});

test("POST /venues rejects a malformed body with 400", async () => {
  const db = openDatabase(":memory:");
  const owner = createOwnerWithPassword(db, "Malformed Venue Owner", "password");
  const token = createSession(db, owner.id, Date.now(), 60_000);

  await withServer(db, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/venues`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: "No Dimensions Venue" }),
    });
    assert.strictEqual(res.status, 400);
  });
  db.close();
});

test("GET /venues rejects a request with no token", async () => {
  const db = openDatabase(":memory:");
  await withServer(db, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/venues`);
    assert.strictEqual(res.status, 401);
  });
  db.close();
});

test("GET /venues returns only the calling owner's own venues", async () => {
  const db = openDatabase(":memory:");
  const ownerA = createOwnerWithPassword(db, "Venues Owner A", "password-a");
  createVenue(db, ownerA.id, { name: "Venue A1", floorWidth: 10, floorHeight: 8 });
  createVenue(db, ownerA.id, { name: "Venue A2", floorWidth: 12, floorHeight: 9 });

  const ownerB = createOwnerWithPassword(db, "Venues Owner B", "password-b");
  createVenue(db, ownerB.id, { name: "Venue B1", floorWidth: 10, floorHeight: 8 });

  const tokenA = createSession(db, ownerA.id, Date.now(), 60_000);

  await withServer(db, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/venues`, { headers: { Authorization: `Bearer ${tokenA}` } });
    assert.strictEqual(res.status, 200);
    const venues = (await res.json()) as Array<{ name: string }>;
    assert.strictEqual(venues.length, 2, "must see exactly owner A's own venues, never owner B's");
    assert.deepStrictEqual(
      venues.map((v) => v.name).sort(),
      ["Venue A1", "Venue A2"]
    );
  });
  db.close();
});

test("GET /venues/:venueId/ap-nodes rejects a request with no token", async () => {
  const db = openDatabase(":memory:");
  const owner = createOwner(db, "AP Nodes No Token Owner");
  const venue = createVenue(db, owner.id, { name: "AP Nodes No Token Venue", floorWidth: 10, floorHeight: 8 });

  await withServer(db, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/venues/${venue.id}/ap-nodes`);
    assert.strictEqual(res.status, 401);
  });
  db.close();
});

test("GET /venues/:venueId/ap-nodes rejects a valid token for a different owner's venue", async () => {
  const db = openDatabase(":memory:");
  const ownerA = createOwnerWithPassword(db, "AP Nodes Owner A", "password-a");
  const ownerB = createOwner(db, "AP Nodes Owner B");
  const venueB = createVenue(db, ownerB.id, { name: "AP Nodes Venue B", floorWidth: 10, floorHeight: 8 });
  const tokenA = createSession(db, ownerA.id, Date.now(), 60_000);

  await withServer(db, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/venues/${venueB.id}/ap-nodes`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert.strictEqual(res.status, 404);
  });
  db.close();
});

test("GET /venues/:venueId/ap-nodes returns the real AP node list for the legitimate owner, unaffected by tier", async () => {
  const db = openDatabase(":memory:");
  const owner = createOwnerWithPassword(db, "AP Nodes Legit Owner", "password");
  setOwnerTier(db, owner.id, "basic"); // deliberately basic — this route must not be tier-gated
  const venue = createVenue(db, owner.id, { name: "AP Nodes Legit Venue", floorWidth: 10, floorHeight: 8 });
  createApNode(db, venue.id, { apNodeId: "ap-1", x: 1, y: 2 });
  createApNode(db, venue.id, { apNodeId: "ap-2", x: 8, y: 6 });
  const token = createSession(db, owner.id, Date.now(), 60_000);

  await withServer(db, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/venues/${venue.id}/ap-nodes`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.strictEqual(res.status, 200);
    const apNodes = (await res.json()) as Array<{ apNodeId: string }>;
    assert.strictEqual(apNodes.length, 2);
    assert.deepStrictEqual(
      apNodes.map((n) => n.apNodeId).sort(),
      ["ap-1", "ap-2"]
    );
  });
  db.close();
});

test("the calibration endpoint rejects a request with no token", async () => {
  const db = openDatabase(":memory:");
  const owner = createOwner(db, "No Token Owner");
  const venue = createVenue(db, owner.id, { name: "No Token Venue", floorWidth: 10, floorHeight: 8 });

  await withServer(db, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/venues/${venue.id}/calibration-samples`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apNodeId: "ap-1", rssi: -55, knownX: 1, knownY: 1 }),
    });
    assert.strictEqual(res.status, 401);
  });
  db.close();
});

test("the calibration endpoint rejects an expired token", async () => {
  const db = openDatabase(":memory:");
  const owner = createOwner(db, "Expired Token Owner");
  const venue = createVenue(db, owner.id, { name: "Expired Token Venue", floorWidth: 10, floorHeight: 8 });
  const expiredToken = createSession(db, owner.id, Date.now() - 10_000, 1); // already expired

  await withServer(db, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/venues/${venue.id}/calibration-samples`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${expiredToken}` },
      body: JSON.stringify({ apNodeId: "ap-1", rssi: -55, knownX: 1, knownY: 1 }),
    });
    assert.strictEqual(res.status, 401);
  });
  db.close();
});

test("a valid token for owner A cannot write a calibration sample to owner B's venue", async () => {
  const db = openDatabase(":memory:");
  const ownerA = createOwnerWithPassword(db, "Owner A", "password-a");
  const ownerB = createOwner(db, "Owner B");
  const venueB = createVenue(db, ownerB.id, { name: "Venue B", floorWidth: 10, floorHeight: 8 });
  const tokenA = createSession(db, ownerA.id, Date.now(), 60_000);

  await withServer(db, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/venues/${venueB.id}/calibration-samples`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ apNodeId: "ap-1", rssi: -55, knownX: 1, knownY: 1 }),
    });
    assert.strictEqual(res.status, 404);
  });

  const rows = db.prepare("SELECT * FROM calibration_samples WHERE venue_id = ?").all(venueB.id);
  assert.strictEqual(rows.length, 0, "the cross-tenant write must not be persisted");
  db.close();
});

test("a valid token for the venue's real owner persists a real calibration sample", async () => {
  const db = openDatabase(":memory:");
  const owner = createOwnerWithPassword(db, "Legit Owner", "password");
  const venue = createVenue(db, owner.id, { name: "Legit Venue", floorWidth: 10, floorHeight: 8 });
  const token = createSession(db, owner.id, Date.now(), 60_000);

  await withServer(db, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/venues/${venue.id}/calibration-samples`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ apNodeId: "ap-1", rssi: -55, knownX: 3, knownY: 4 }),
    });
    assert.strictEqual(res.status, 201);
  });

  const rows = db.prepare("SELECT * FROM calibration_samples WHERE venue_id = ?").all(venue.id) as Array<{
    rssi: number;
    known_x: number;
    known_y: number;
  }>;
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0]?.rssi, -55);
  assert.strictEqual(rows[0]?.known_x, 3);
  assert.strictEqual(rows[0]?.known_y, 4);
  db.close();
});

test("GET /venues/:venueId/heatmap rejects a request with no token", async () => {
  const db = openDatabase(":memory:");
  const owner = createOwner(db, "Heatmap No Token Owner");
  const venue = createVenue(db, owner.id, { name: "Heatmap Venue", floorWidth: 10, floorHeight: 8 });

  await withServer(db, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/venues/${venue.id}/heatmap`);
    assert.strictEqual(res.status, 401);
  });
  db.close();
});

test("GET /venues/:venueId/heatmap rejects a valid token for a different owner's venue", async () => {
  const db = openDatabase(":memory:");
  const ownerA = createOwnerWithPassword(db, "Heatmap Owner A", "password-a");
  const ownerB = createOwner(db, "Heatmap Owner B");
  const venueB = createVenue(db, ownerB.id, { name: "Heatmap Venue B", floorWidth: 10, floorHeight: 8 });
  const tokenA = createSession(db, ownerA.id, Date.now(), 60_000);

  await withServer(db, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/venues/${venueB.id}/heatmap`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert.strictEqual(res.status, 404);
  });
  db.close();
});

test("GET /venues/:venueId/heatmap returns the same data computeVenueHeatmap would return directly", async () => {
  const db = openDatabase(":memory:");
  const owner = createOwnerWithPassword(db, "Heatmap Legit Owner", "password");
  setOwnerTier(db, owner.id, "premium"); // heatmap access requires standard/premium (KR7)
  const venue = createVenue(db, owner.id, { name: "Heatmap Legit Venue", floorWidth: 10, floorHeight: 8 });
  const apNode = createApNode(db, venue.id, { apNodeId: "ap-1", x: 0, y: 0 });
  const hashedDeviceId = hashDeviceId("aa:bb:cc:dd:ee:ff", "test-salt");
  recordConsentGrant(db, { tenantId: owner.id, venueId: venue.id, hashedDeviceId, termsVersion: "v1" });
  ingestApEvent(db, {
    type: "signal_reading",
    hashedDeviceId,
    tenantId: owner.id,
    venueId: venue.id,
    apNodeId: apNode.apNodeId,
    timestamp: 1000,
    rssi: -55,
  });

  const token = createSession(db, owner.id, Date.now(), 60_000);
  const expected = computeVenueHeatmap(db, owner.id, venue.id);

  await withServer(db, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/venues/${venue.id}/heatmap`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.strictEqual(res.status, 200);
    const json = await res.json();
    assert.deepStrictEqual(json, expected);
  });
  db.close();
});

test("GET /venues/:venueId/return-visit-stats rejects a request with no token", async () => {
  const db = openDatabase(":memory:");
  const owner = createOwner(db, "Stats No Token Owner");
  const venue = createVenue(db, owner.id, { name: "Stats Venue", floorWidth: 10, floorHeight: 8 });

  await withServer(db, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/venues/${venue.id}/return-visit-stats`);
    assert.strictEqual(res.status, 401);
  });
  db.close();
});

test("GET /venues/:venueId/return-visit-stats rejects a valid token for a different owner's venue", async () => {
  const db = openDatabase(":memory:");
  const ownerA = createOwnerWithPassword(db, "Stats Owner A", "password-a");
  const ownerB = createOwner(db, "Stats Owner B");
  const venueB = createVenue(db, ownerB.id, { name: "Stats Venue B", floorWidth: 10, floorHeight: 8 });
  const tokenA = createSession(db, ownerA.id, Date.now(), 60_000);

  await withServer(db, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/venues/${venueB.id}/return-visit-stats`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert.strictEqual(res.status, 404);
  });
  db.close();
});

test("GET /venues/:venueId/return-visit-stats returns the same data computeReturnVisitStats would return directly", async () => {
  const db = openDatabase(":memory:");
  const owner = createOwnerWithPassword(db, "Stats Legit Owner", "password");
  setOwnerTier(db, owner.id, "premium"); // only premium returns return-visit-stats fully unredacted (KR7)
  const venue = createVenue(db, owner.id, { name: "Stats Legit Venue", floorWidth: 10, floorHeight: 8 });
  const hashedDeviceId = hashDeviceId("aa:bb:cc:dd:ee:ff", "test-salt");
  recordConsentGrant(db, { tenantId: owner.id, venueId: venue.id, hashedDeviceId, termsVersion: "v1" });
  ingestApEvent(db, {
    type: "join",
    hashedDeviceId,
    tenantId: owner.id,
    venueId: venue.id,
    apNodeId: "ap-1",
    timestamp: 1000,
  });
  ingestApEvent(db, {
    type: "leave",
    hashedDeviceId,
    tenantId: owner.id,
    venueId: venue.id,
    apNodeId: "ap-1",
    timestamp: 4000,
  });

  const token = createSession(db, owner.id, Date.now(), 60_000);
  const expected = computeReturnVisitStats(db, owner.id, venue.id);

  await withServer(db, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/venues/${venue.id}/return-visit-stats`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.strictEqual(res.status, 200);
    const json = await res.json();
    assert.deepStrictEqual(json, expected);
  });
  db.close();
});

test("GET /venues/:venueId/heatmap: a basic-tier owner is denied with 402, and the heatmap is never computed", async () => {
  const db = openDatabase(":memory:");
  const owner = createOwnerWithPassword(db, "Basic Tier Owner", "password");
  // No setOwnerTier call — defaults to "basic".
  const venue = createVenue(db, owner.id, { name: "Basic Tier Venue", floorWidth: 10, floorHeight: 8 });
  const token = createSession(db, owner.id, Date.now(), 60_000);

  await withServer(db, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/venues/${venue.id}/heatmap`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.strictEqual(res.status, 402);
    const json = (await res.json()) as { error: string; requiredTier: string };
    assert.strictEqual(json.requiredTier, "standard");
  });
  db.close();
});

test("GET /venues/:venueId/heatmap: a standard-tier owner is allowed", async () => {
  const db = openDatabase(":memory:");
  const owner = createOwnerWithPassword(db, "Standard Tier Owner", "password");
  setOwnerTier(db, owner.id, "standard");
  const venue = createVenue(db, owner.id, { name: "Standard Tier Venue", floorWidth: 10, floorHeight: 8 });
  const token = createSession(db, owner.id, Date.now(), 60_000);

  await withServer(db, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/venues/${venue.id}/heatmap`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.strictEqual(res.status, 200);
  });
  db.close();
});

test("GET /venues/:venueId/return-visit-stats: a basic-tier owner gets real aggregate counts but empty perDevice and a zeroed hourOfDayDistribution", async () => {
  const db = openDatabase(":memory:");
  const owner = createOwnerWithPassword(db, "Basic Stats Owner", "password");
  // No setOwnerTier call — defaults to "basic".
  const venue = createVenue(db, owner.id, { name: "Basic Stats Venue", floorWidth: 10, floorHeight: 8 });
  const hashedDeviceId = hashDeviceId("aa:bb:cc:dd:ee:ff", "test-salt");
  recordConsentGrant(db, { tenantId: owner.id, venueId: venue.id, hashedDeviceId, termsVersion: "v1" });
  ingestApEvent(db, { type: "join", hashedDeviceId, tenantId: owner.id, venueId: venue.id, apNodeId: "ap-1", timestamp: 1000 });
  ingestApEvent(db, { type: "leave", hashedDeviceId, tenantId: owner.id, venueId: venue.id, apNodeId: "ap-1", timestamp: 4000 });

  const rawStats = computeReturnVisitStats(db, owner.id, venue.id);
  const token = createSession(db, owner.id, Date.now(), 60_000);

  await withServer(db, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/venues/${venue.id}/return-visit-stats`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.strictEqual(res.status, 200);
    const json = (await res.json()) as {
      perDevice: unknown[];
      hourOfDayDistribution: number[];
      newDeviceCount: number;
      returningDeviceCount: number;
      returningRatio: number;
    };
    assert.deepStrictEqual(json.perDevice, []);
    assert.strictEqual(json.hourOfDayDistribution.length, 24);
    assert.ok(json.hourOfDayDistribution.every((v) => v === 0));
    assert.strictEqual(json.newDeviceCount, rawStats.newDeviceCount, "aggregate counts must be the real, unredacted numbers");
    assert.strictEqual(json.returningDeviceCount, rawStats.returningDeviceCount);
    assert.strictEqual(json.returningRatio, rawStats.returningRatio);
  });
  db.close();
});

test("GET /venues/:venueId/return-visit-stats: a standard-tier owner gets real hourOfDayDistribution but empty perDevice", async () => {
  const db = openDatabase(":memory:");
  const owner = createOwnerWithPassword(db, "Standard Stats Owner", "password");
  setOwnerTier(db, owner.id, "standard");
  const venue = createVenue(db, owner.id, { name: "Standard Stats Venue", floorWidth: 10, floorHeight: 8 });
  const hashedDeviceId = hashDeviceId("aa:bb:cc:dd:ee:ff", "test-salt");
  recordConsentGrant(db, { tenantId: owner.id, venueId: venue.id, hashedDeviceId, termsVersion: "v1" });
  ingestApEvent(db, { type: "join", hashedDeviceId, tenantId: owner.id, venueId: venue.id, apNodeId: "ap-1", timestamp: 1000 });
  ingestApEvent(db, { type: "leave", hashedDeviceId, tenantId: owner.id, venueId: venue.id, apNodeId: "ap-1", timestamp: 4000 });

  const rawStats = computeReturnVisitStats(db, owner.id, venue.id);
  const token = createSession(db, owner.id, Date.now(), 60_000);

  await withServer(db, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/venues/${venue.id}/return-visit-stats`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.strictEqual(res.status, 200);
    const json = (await res.json()) as { perDevice: unknown[]; hourOfDayDistribution: number[] };
    assert.deepStrictEqual(json.perDevice, []);
    assert.deepStrictEqual(json.hourOfDayDistribution, rawStats.hourOfDayDistribution);
  });
  db.close();
});

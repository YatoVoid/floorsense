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

test("GET /billing/pricing returns the real tier prices with no auth required", async () => {
  const db = openDatabase(":memory:");
  await withServer(db, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/billing/pricing`);
    assert.strictEqual(res.status, 200);
    const pricing = (await res.json()) as { basic: number; standard: number; premium: number };
    assert.strictEqual(pricing.basic, 0);
    assert.ok(pricing.standard > 0);
    assert.ok(pricing.premium > pricing.standard);
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
    assert.strictEqual(wrongBody, unknownBody, "the two failure responses must be byte-identical");
  });
  db.close();
});

test("POST /auth/register creates a real owner and returns an immediately-usable session token", async () => {
  const db = openDatabase(":memory:");
  await withServer(db, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Brand New Owner", password: "a-real-password", tier: "basic" }),
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
      body: JSON.stringify({ name: "Existing Owner", password: "second-password", tier: "basic" }),
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

test("POST /auth/register rejects a missing or unknown tier with 400", async () => {
  const db = openDatabase(":memory:");
  await withServer(db, async (baseUrl) => {
    const noTierRes = await fetch(`${baseUrl}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "No Tier Owner", password: "a-real-password" }),
    });
    assert.strictEqual(noTierRes.status, 400);

    const unknownTierRes = await fetch(`${baseUrl}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Unknown Tier Owner", password: "a-real-password", tier: "gold" }),
    });
    assert.strictEqual(unknownTierRes.status, 400);
  });
  db.close();
});

test("POST /auth/register persists the chosen tier and records a matching signup transaction", async () => {
  const db = openDatabase(":memory:");
  await withServer(db, async (baseUrl) => {
    for (const tier of ["basic", "standard", "premium"] as const) {
      const res = await fetch(`${baseUrl}/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: `${tier} Register Owner`, password: "a-real-password", tier }),
      });
      assert.strictEqual(res.status, 201);
      const body = (await res.json()) as { token: string; tier: string };
      assert.strictEqual(body.tier, tier);

      const historyRes = await fetch(`${baseUrl}/billing/history`, {
        headers: { Authorization: `Bearer ${body.token}` },
      });
      const history = (await historyRes.json()) as Array<{ kind: string; tier: string }>;
      assert.strictEqual(history.length, 1, `a signup transaction must exist for the ${tier} tier`);
      assert.strictEqual(history[0]?.kind, "signup");
      assert.strictEqual(history[0]?.tier, tier);
    }
  });
  db.close();
});

test("POST /auth/register: an owner named Wali always gets premium, regardless of the requested tier", async () => {
  const db = openDatabase(":memory:");
  await withServer(db, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Wali", password: "a-real-password", tier: "basic" }),
    });
    assert.strictEqual(res.status, 201);
    const body = (await res.json()) as { token: string; tier: string };
    assert.strictEqual(body.tier, "premium", "the test override must win over the requested tier");

    const historyRes = await fetch(`${baseUrl}/billing/history`, {
      headers: { Authorization: `Bearer ${body.token}` },
    });
    const history = (await historyRes.json()) as Array<{ tier: string; amountCents: number }>;
    assert.strictEqual(history.length, 1);
    assert.strictEqual(history[0]?.tier, "premium");
  });
  db.close();
});

test("GET /billing/history rejects a request with no token", async () => {
  const db = openDatabase(":memory:");
  await withServer(db, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/billing/history`);
    assert.strictEqual(res.status, 401);
  });
  db.close();
});

test("GET /billing/history returns only the calling owner's own transactions", async () => {
  const db = openDatabase(":memory:");
  await withServer(db, async (baseUrl) => {
    const ownerARes = await fetch(`${baseUrl}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "History Owner A", password: "a-real-password", tier: "standard" }),
    });
    const ownerA = (await ownerARes.json()) as { token: string };

    const ownerBRes = await fetch(`${baseUrl}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "History Owner B", password: "a-real-password", tier: "premium" }),
    });
    const ownerB = (await ownerBRes.json()) as { token: string };

    const historyARes = await fetch(`${baseUrl}/billing/history`, {
      headers: { Authorization: `Bearer ${ownerA.token}` },
    });
    const historyA = (await historyARes.json()) as Array<{ tier: string }>;
    assert.strictEqual(historyA.length, 1);
    assert.strictEqual(historyA[0]?.tier, "standard", "owner A must never see owner B's premium transaction");

    void ownerB;
  });
  db.close();
});

test("POST /billing/simulate-monthly-charge rejects a request with no token", async () => {
  const db = openDatabase(":memory:");
  await withServer(db, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/billing/simulate-monthly-charge`, { method: "POST" });
    assert.strictEqual(res.status, 401);
  });
  db.close();
});

test("POST /billing/simulate-monthly-charge appends a real monthly transaction visible in history", async () => {
  const db = openDatabase(":memory:");
  await withServer(db, async (baseUrl) => {
    const registerRes = await fetch(`${baseUrl}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Monthly Charge Owner", password: "a-real-password", tier: "standard" }),
    });
    const { token } = (await registerRes.json()) as { token: string };

    const chargeRes = await fetch(`${baseUrl}/billing/simulate-monthly-charge`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.strictEqual(chargeRes.status, 201);
    const charge = (await chargeRes.json()) as { kind: string; tier: string };
    assert.strictEqual(charge.kind, "monthly");
    assert.strictEqual(charge.tier, "standard");

    const historyRes = await fetch(`${baseUrl}/billing/history`, { headers: { Authorization: `Bearer ${token}` } });
    const history = (await historyRes.json()) as Array<{ kind: string }>;
    assert.strictEqual(history.length, 2, "signup + the new monthly charge");
    assert.deepStrictEqual(
      history.map((t) => t.kind).sort(),
      ["monthly", "signup"]
    );
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
  setOwnerTier(db, owner.id, "basic"); // basic tier on purpose: this route should not be gated
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

test("POST /venues/:venueId/ap-nodes rejects a request with no token", async () => {
  const db = openDatabase(":memory:");
  const owner = createOwner(db, "AP Node Create No Token Owner");
  const venue = createVenue(db, owner.id, { name: "AP Node Create Venue", floorWidth: 10, floorHeight: 8 });

  await withServer(db, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/venues/${venue.id}/ap-nodes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apNodeId: "ap-1", x: 1, y: 1 }),
    });
    assert.strictEqual(res.status, 401);
  });
  db.close();
});

test("POST /venues/:venueId/ap-nodes rejects a valid token for a different owner's venue", async () => {
  const db = openDatabase(":memory:");
  const ownerA = createOwnerWithPassword(db, "AP Node Create Owner A", "password-a");
  const ownerB = createOwner(db, "AP Node Create Owner B");
  const venueB = createVenue(db, ownerB.id, { name: "AP Node Create Venue B", floorWidth: 10, floorHeight: 8 });
  const tokenA = createSession(db, ownerA.id, Date.now(), 60_000);

  await withServer(db, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/venues/${venueB.id}/ap-nodes`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ apNodeId: "ap-1", x: 1, y: 1 }),
    });
    assert.strictEqual(res.status, 404);
  });
  db.close();
});

test("POST /venues/:venueId/ap-nodes rejects a malformed body with 400", async () => {
  const db = openDatabase(":memory:");
  const owner = createOwnerWithPassword(db, "AP Node Create Malformed Owner", "password");
  const venue = createVenue(db, owner.id, { name: "AP Node Create Malformed Venue", floorWidth: 10, floorHeight: 8 });
  const token = createSession(db, owner.id, Date.now(), 60_000);

  await withServer(db, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/venues/${venue.id}/ap-nodes`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ apNodeId: "ap-1" }),
    });
    assert.strictEqual(res.status, 400);
  });
  db.close();
});

test("POST /venues/:venueId/ap-nodes creates a real AP node, immediately visible via GET", async () => {
  const db = openDatabase(":memory:");
  const owner = createOwnerWithPassword(db, "AP Node Create Legit Owner", "password");
  const venue = createVenue(db, owner.id, { name: "AP Node Create Legit Venue", floorWidth: 10, floorHeight: 8 });
  const token = createSession(db, owner.id, Date.now(), 60_000);

  await withServer(db, async (baseUrl) => {
    const createRes = await fetch(`${baseUrl}/venues/${venue.id}/ap-nodes`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ apNodeId: "ap-1", x: 3, y: 4 }),
    });
    assert.strictEqual(createRes.status, 201);
    const created = (await createRes.json()) as { apNodeId: string; x: number; y: number };
    assert.strictEqual(created.apNodeId, "ap-1");
    assert.strictEqual(created.x, 3);
    assert.strictEqual(created.y, 4);

    const listRes = await fetch(`${baseUrl}/venues/${venue.id}/ap-nodes`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const apNodes = (await listRes.json()) as Array<{ apNodeId: string }>;
    assert.strictEqual(apNodes.length, 1);
    assert.strictEqual(apNodes[0]?.apNodeId, "ap-1");
  });
  db.close();
});

test("POST /venues/:venueId/ap-nodes rejects a duplicate apNodeId within the same venue with 409, not a silent overwrite or 500", async () => {
  const db = openDatabase(":memory:");
  const owner = createOwnerWithPassword(db, "AP Node Duplicate Owner", "password");
  const venue = createVenue(db, owner.id, { name: "AP Node Duplicate Venue", floorWidth: 10, floorHeight: 8 });
  const token = createSession(db, owner.id, Date.now(), 60_000);

  await withServer(db, async (baseUrl) => {
    const firstRes = await fetch(`${baseUrl}/venues/${venue.id}/ap-nodes`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ apNodeId: "ap-1", x: 1, y: 1 }),
    });
    assert.strictEqual(firstRes.status, 201);

    const secondRes = await fetch(`${baseUrl}/venues/${venue.id}/ap-nodes`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ apNodeId: "ap-1", x: 9, y: 9 }),
    });
    assert.strictEqual(secondRes.status, 409);
  });

  const rows = db.prepare("SELECT x, y FROM ap_nodes WHERE venue_id = ? AND ap_node_id = ?").all(venue.id, "ap-1") as Array<{
    x: number;
    y: number;
  }>;
  assert.strictEqual(rows.length, 1, "the duplicate attempt must not create a second row");
  assert.strictEqual(rows[0]?.x, 1, "the original AP node's position must be unchanged");
  db.close();
});

test("POST /hardware/events rejects the wrong hardware token for a real venue", async () => {
  const db = openDatabase(":memory:");
  const owner = createOwnerWithPassword(db, "Hardware Wrong Token Owner", "password");
  const venue = createVenue(db, owner.id, { name: "Hardware Venue", floorWidth: 10, floorHeight: 8 });
  createApNode(db, venue.id, { apNodeId: "ap-1", x: 0, y: 0 });

  await withServer(db, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/hardware/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        venueId: venue.id,
        hardwareToken: "not-the-real-token",
        apNodeId: "ap-1",
        deviceMac: "aa:bb:cc:dd:ee:ff",
        eventType: "join",
      }),
    });
    assert.strictEqual(res.status, 401);
  });
  db.close();
});

test("POST /hardware/events rejects an unknown venueId", async () => {
  const db = openDatabase(":memory:");
  await withServer(db, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/hardware/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        venueId: "no-such-venue",
        hardwareToken: "anything",
        apNodeId: "ap-1",
        deviceMac: "aa:bb:cc:dd:ee:ff",
        eventType: "join",
      }),
    });
    assert.strictEqual(res.status, 401);
  });
  db.close();
});

test("POST /hardware/events rejects a malformed body with 400", async () => {
  const db = openDatabase(":memory:");
  const owner = createOwnerWithPassword(db, "Hardware Malformed Owner", "password");
  const venue = createVenue(db, owner.id, { name: "Hardware Venue", floorWidth: 10, floorHeight: 8 });

  await withServer(db, async (baseUrl) => {
    const missingFieldsRes = await fetch(`${baseUrl}/hardware/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ venueId: venue.id, hardwareToken: venue.hardwareToken }),
    });
    assert.strictEqual(missingFieldsRes.status, 400);

    const unknownEventTypeRes = await fetch(`${baseUrl}/hardware/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        venueId: venue.id,
        hardwareToken: venue.hardwareToken,
        apNodeId: "ap-1",
        deviceMac: "aa:bb:cc:dd:ee:ff",
        eventType: "not-a-real-type",
      }),
    });
    assert.strictEqual(unknownEventTypeRes.status, 400);

    const missingRssiRes = await fetch(`${baseUrl}/hardware/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        venueId: venue.id,
        hardwareToken: venue.hardwareToken,
        apNodeId: "ap-1",
        deviceMac: "aa:bb:cc:dd:ee:ff",
        eventType: "signal_reading",
      }),
    });
    assert.strictEqual(missingRssiRes.status, 400);
  });
  db.close();
});

test("POST /hardware/events rejects a device with no consent grant, same reason every other ingestion path uses", async () => {
  const db = openDatabase(":memory:");
  const owner = createOwnerWithPassword(db, "Hardware No Consent Owner", "password");
  const venue = createVenue(db, owner.id, { name: "Hardware Venue", floorWidth: 10, floorHeight: 8 });
  createApNode(db, venue.id, { apNodeId: "ap-1", x: 0, y: 0 });

  await withServer(db, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/hardware/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        venueId: venue.id,
        hardwareToken: venue.hardwareToken,
        apNodeId: "ap-1",
        deviceMac: "aa:bb:cc:dd:ee:ff",
        eventType: "join",
      }),
    });
    assert.strictEqual(res.status, 403);
    const body = (await res.json()) as { error: string };
    assert.strictEqual(body.error, "no_consent");
  });
  db.close();
});

test("POST /hardware/events accepts join/signal_reading/leave for a consented device, visible through the owner's existing endpoints", async () => {
  const db = openDatabase(":memory:");
  const owner = createOwnerWithPassword(db, "Hardware Accept Owner", "password");
  const venue = createVenue(db, owner.id, { name: "Hardware Venue", floorWidth: 10, floorHeight: 8 });
  createApNode(db, venue.id, { apNodeId: "ap-1", x: 0, y: 0 });
  const ownerToken = createSession(db, owner.id, Date.now(), 60_000);

  const hashedDeviceId = hashDeviceId("aa:bb:cc:dd:ee:ff", venue.hardwareToken);
  recordConsentGrant(db, { tenantId: owner.id, venueId: venue.id, hashedDeviceId, termsVersion: "v1" });

  await withServer(db, async (baseUrl) => {
    async function sendEvent(body: Record<string, unknown>) {
      return fetch(`${baseUrl}/hardware/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ venueId: venue.id, hardwareToken: venue.hardwareToken, apNodeId: "ap-1", deviceMac: "aa:bb:cc:dd:ee:ff", ...body }),
      });
    }

    const joinRes = await sendEvent({ eventType: "join" });
    assert.strictEqual(joinRes.status, 201);

    const signalRes = await sendEvent({ eventType: "signal_reading", rssi: -55 });
    assert.strictEqual(signalRes.status, 201);

    const leaveRes = await sendEvent({ eventType: "leave" });
    assert.strictEqual(leaveRes.status, 201);

    const statsRes = await fetch(`${baseUrl}/venues/${venue.id}/return-visit-stats`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const stats = (await statsRes.json()) as { newDeviceCount: number };
    assert.strictEqual(stats.newDeviceCount, 1, "the join/leave pair must be visible through the owner's own dashboard endpoint");
  });
  db.close();
});

test("POST /hardware/events: the same raw MAC always hashes to the same hashedDeviceId (return-visit continuity)", async () => {
  const db = openDatabase(":memory:");
  const owner = createOwnerWithPassword(db, "Hardware Continuity Owner", "password");
  const venue = createVenue(db, owner.id, { name: "Hardware Venue", floorWidth: 10, floorHeight: 8 });
  createApNode(db, venue.id, { apNodeId: "ap-1", x: 0, y: 0 });

  const hashedDeviceId = hashDeviceId("aa:bb:cc:dd:ee:ff", venue.hardwareToken);
  recordConsentGrant(db, { tenantId: owner.id, venueId: venue.id, hashedDeviceId, termsVersion: "v1" });

  await withServer(db, async (baseUrl) => {
    for (const eventType of ["join", "leave"]) {
      const res = await fetch(`${baseUrl}/hardware/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          venueId: venue.id,
          hardwareToken: venue.hardwareToken,
          apNodeId: "ap-1",
          deviceMac: "aa:bb:cc:dd:ee:ff",
          eventType,
        }),
      });
      assert.strictEqual(res.status, 201, `${eventType} must be accepted - consent was granted for the exact hash this endpoint computes`);
    }
  });

  const rows = db.prepare("SELECT DISTINCT hashed_device_id FROM ap_events WHERE venue_id = ?").all(venue.id) as Array<{
    hashed_device_id: string;
  }>;
  assert.strictEqual(rows.length, 1, "both events for the same raw MAC must store the identical hashedDeviceId");
  assert.strictEqual(rows[0]?.hashed_device_id, hashedDeviceId);
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
  // no setOwnerTier call, defaults to basic
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
  // no setOwnerTier call, defaults to basic
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

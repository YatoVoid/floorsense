import assert from "node:assert";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import {
  openDatabase,
  createOwnerWithPassword,
  createOwner,
  createVenue,
  createSession,
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

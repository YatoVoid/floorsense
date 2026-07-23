import assert from "node:assert";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { hashDeviceId } from "@floorsense/shared";
import { openDatabase, createOwner, createVenue, hasConsent } from "@floorsense/backend";
import { createCaptivePortalServer } from "./server.ts";

function setupTenant(db: ReturnType<typeof openDatabase>) {
  const owner = createOwner(db, "Portal Test Owner");
  const venue = createVenue(db, owner.id, { name: "Portal Test Venue", floorWidth: 10, floorHeight: 8 });
  return { tenantId: owner.id, venueId: venue.id };
}

async function withServer(
  db: ReturnType<typeof openDatabase>,
  config: { tenantId: string; venueId: string; deviceIdSalt?: string },
  fn: (baseUrl: string) => Promise<void>
) {
  const server = createCaptivePortalServer(db, {
    tenantId: config.tenantId,
    venueId: config.venueId,
    venueName: "Portal Test Venue",
    termsVersion: "v1",
    deviceIdSalt: config.deviceIdSalt,
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("GET / serves the splash page containing the venue name", async () => {
  const db = openDatabase(":memory:");
  const { tenantId, venueId } = setupTenant(db);

  await withServer(db, { tenantId, venueId }, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/?deviceId=abc123`);
    assert.strictEqual(res.status, 200);
    const html = await res.text();
    assert.match(html, /Portal Test Venue/);
    assert.match(html, /abc123/);
  });
  db.close();
});

test("GET /?rawMac=... hashes the raw MAC server-side with deviceIdSalt, for real AP hardware that never computes the hash itself", async () => {
  const db = openDatabase(":memory:");
  const { tenantId, venueId } = setupTenant(db);
  const salt = "a-real-venue-hardware-token";

  await withServer(db, { tenantId, venueId, deviceIdSalt: salt }, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/?rawMac=aa:bb:cc:dd:ee:ff`);
    assert.strictEqual(res.status, 200);
    const html = await res.text();

    const expectedHash = hashDeviceId("aa:bb:cc:dd:ee:ff", salt);
    assert.match(html, new RegExp(expectedHash), "the page must embed the SERVER-COMPUTED hash, not the raw MAC");
    assert.doesNotMatch(html, /aa:bb:cc:dd:ee:ff/, "the raw MAC must never appear in the rendered page");
  });
  db.close();
});

test("GET /?rawMac=... without a configured deviceIdSalt falls back to an empty hashedDeviceId, not an unsalted hash", async () => {
  const db = openDatabase(":memory:");
  const { tenantId, venueId } = setupTenant(db);

  await withServer(db, { tenantId, venueId }, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/?rawMac=aa:bb:cc:dd:ee:ff`);
    assert.strictEqual(res.status, 200);
    const html = await res.text();
    assert.doesNotMatch(html, /aa:bb:cc:dd:ee:ff/, "the raw MAC must never leak into the page even without a salt configured");
  });
  db.close();
});

test("POST /consent/accept with a valid body records a consent grant for this portal's fixed tenant/venue", async () => {
  const db = openDatabase(":memory:");
  const { tenantId, venueId } = setupTenant(db);

  await withServer(db, { tenantId, venueId }, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/consent/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hashedDeviceId: "hashed-abc123", termsVersion: "v1" }),
    });
    assert.strictEqual(res.status, 200);
    const json = (await res.json()) as { accepted: boolean };
    assert.strictEqual(json.accepted, true);
  });

  assert.strictEqual(hasConsent(db, tenantId, venueId, "hashed-abc123"), true);
  db.close();
});

test("POST /consent/accept with a missing hashedDeviceId is rejected with 400, not a crash", async () => {
  const db = openDatabase(":memory:");
  const { tenantId, venueId } = setupTenant(db);

  await withServer(db, { tenantId, venueId }, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/consent/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ termsVersion: "v1" }),
    });
    assert.strictEqual(res.status, 400);
  });
  db.close();
});

test("POST /consent/accept with malformed JSON is rejected with 400, not a 500", async () => {
  const db = openDatabase(":memory:");
  const { tenantId, venueId } = setupTenant(db);

  await withServer(db, { tenantId, venueId }, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/consent/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not valid json",
    });
    assert.strictEqual(res.status, 400);
  });
  db.close();
});

test("an unknown route returns 404", async () => {
  const db = openDatabase(":memory:");
  const { tenantId, venueId } = setupTenant(db);

  await withServer(db, { tenantId, venueId }, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/nonexistent`);
    assert.strictEqual(res.status, 404);
  });
  db.close();
});

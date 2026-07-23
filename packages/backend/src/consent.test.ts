import assert from "node:assert";
import { test } from "node:test";
import { hashDeviceId } from "@floorsense/shared";
import { openDatabase } from "./db.ts";
import { createOwner, createVenue } from "./tenancy.ts";
import { recordConsentGrant, hasConsent } from "./consent.ts";

function setupTenant(db: ReturnType<typeof openDatabase>) {
  const owner = createOwner(db, "Test Owner");
  const venue = createVenue(db, owner.id, { name: "Test Venue", floorWidth: 10, floorHeight: 8 });
  return { ownerId: owner.id, venueId: venue.id };
}

test("hasConsent is false before any grant is recorded", () => {
  const db = openDatabase(":memory:");
  const { ownerId, venueId } = setupTenant(db);
  const hashedDeviceId = hashDeviceId("aa:bb:cc:dd:ee:ff", "test-salt");

  assert.strictEqual(hasConsent(db, ownerId, venueId, hashedDeviceId), false);
  db.close();
});

test("recordConsentGrant makes hasConsent true for that exact tenant/venue/device triple", () => {
  const db = openDatabase(":memory:");
  const { ownerId, venueId } = setupTenant(db);
  const hashedDeviceId = hashDeviceId("aa:bb:cc:dd:ee:ff", "test-salt");

  recordConsentGrant(db, { tenantId: ownerId, venueId, hashedDeviceId, termsVersion: "v1" });

  assert.strictEqual(hasConsent(db, ownerId, venueId, hashedDeviceId), true);
  db.close();
});

test("consent is scoped to venue: a grant at one venue does not cover another", () => {
  const db = openDatabase(":memory:");
  const owner = createOwner(db, "Multi-venue Owner");
  const venueA = createVenue(db, owner.id, { name: "Venue A", floorWidth: 10, floorHeight: 8 });
  const venueB = createVenue(db, owner.id, { name: "Venue B", floorWidth: 10, floorHeight: 8 });
  const hashedDeviceId = hashDeviceId("aa:bb:cc:dd:ee:ff", "test-salt");

  recordConsentGrant(db, { tenantId: owner.id, venueId: venueA.id, hashedDeviceId, termsVersion: "v1" });

  assert.strictEqual(hasConsent(db, owner.id, venueA.id, hashedDeviceId), true);
  assert.strictEqual(hasConsent(db, owner.id, venueB.id, hashedDeviceId), false);
  db.close();
});

test("granting consent twice for the same triple does not create duplicate rows and keeps the latest terms version", () => {
  const db = openDatabase(":memory:");
  const { ownerId, venueId } = setupTenant(db);
  const hashedDeviceId = hashDeviceId("aa:bb:cc:dd:ee:ff", "test-salt");

  recordConsentGrant(db, { tenantId: ownerId, venueId, hashedDeviceId, termsVersion: "v1" });
  recordConsentGrant(db, { tenantId: ownerId, venueId, hashedDeviceId, termsVersion: "v2" });

  const rows = db
    .prepare("SELECT terms_version FROM consent_grants WHERE tenant_id = ? AND venue_id = ? AND hashed_device_id = ?")
    .all(ownerId, venueId, hashedDeviceId) as Array<{ terms_version: string }>;
  assert.strictEqual(rows.length, 1, "re-granting consent must update the existing row, not insert a second one");
  assert.strictEqual(rows[0]?.terms_version, "v2");
  db.close();
});

import assert from "node:assert";
import { test } from "node:test";
import { openDatabase } from "./db.ts";
import { createOwner, createVenue, createApNode } from "./tenancy.ts";
import {
  recordCalibrationSample,
  fitCalibrationProfile,
  getCalibrationProfile,
  DEFAULT_CALIBRATION_PROFILE,
  MIN_CALIBRATION_SAMPLES,
} from "./calibration.ts";
import type { CalibrationProfile } from "@floorsense/positioning";

function setupTenant(db: ReturnType<typeof openDatabase>) {
  const owner = createOwner(db, "Calibration Test Owner");
  const venue = createVenue(db, owner.id, { name: "Calibration Test Venue", floorWidth: 20, floorHeight: 15 });
  const apNode = createApNode(db, venue.id, { apNodeId: "ap-1", x: 0, y: 0 });
  return { tenantId: owner.id, venueId: venue.id, apNode };
}

function rssiAtDistance(distance: number, profile: CalibrationProfile): number {
  return profile.referenceRssiAt1m - 10 * profile.pathLossExponent * Math.log10(distance);
}

test("fitCalibrationProfile recovers a known ground-truth profile from noiseless samples", () => {
  const db = openDatabase(":memory:");
  const { tenantId, venueId, apNode } = setupTenant(db);
  const groundTruth: CalibrationProfile = { referenceRssiAt1m: -42, pathLossExponent: 3.0 };

  for (const distance of [1, 2, 4, 8, 16]) {
    recordCalibrationSample(db, {
      tenantId,
      venueId,
      apNodeId: apNode.apNodeId,
      rssi: rssiAtDistance(distance, groundTruth),
      knownX: distance,
      knownY: 0,
    });
  }

  const fitted = fitCalibrationProfile(db, tenantId, venueId);
  assert.ok(fitted, "expected a successful fit with 5 samples spanning a range of distances");
  assert.ok(Math.abs(fitted.referenceRssiAt1m - groundTruth.referenceRssiAt1m) < 1e-6);
  assert.ok(Math.abs(fitted.pathLossExponent - groundTruth.pathLossExponent) < 1e-6);

  const stored = getCalibrationProfile(db, tenantId, venueId);
  assert.deepStrictEqual(stored, fitted, "the fitted profile must be persisted and retrievable");
  db.close();
});

test("fewer than MIN_CALIBRATION_SAMPLES samples yields no fit, and getCalibrationProfile returns the default", () => {
  const db = openDatabase(":memory:");
  const { tenantId, venueId, apNode } = setupTenant(db);
  assert.ok(MIN_CALIBRATION_SAMPLES >= 2, "sanity check on the exported constant");

  for (let i = 0; i < MIN_CALIBRATION_SAMPLES - 1; i++) {
    recordCalibrationSample(db, {
      tenantId,
      venueId,
      apNodeId: apNode.apNodeId,
      rssi: -55,
      knownX: i + 1,
      knownY: 0,
    });
  }

  const fitted = fitCalibrationProfile(db, tenantId, venueId);
  assert.strictEqual(fitted, null);

  const profile = getCalibrationProfile(db, tenantId, venueId);
  assert.deepStrictEqual(profile, DEFAULT_CALIBRATION_PROFILE);
  db.close();
});

test("a venue with zero calibration samples gets the default profile, not an error", () => {
  const db = openDatabase(":memory:");
  const { tenantId, venueId } = setupTenant(db);

  const profile = getCalibrationProfile(db, tenantId, venueId);
  assert.deepStrictEqual(profile, DEFAULT_CALIBRATION_PROFILE);
  db.close();
});

test("calibration is tenant-isolated: owner A's samples and fitted profile never leak into owner B's venue", () => {
  const db = openDatabase(":memory:");
  const ownerA = createOwner(db, "Owner A");
  const venueA = createVenue(db, ownerA.id, { name: "Venue A", floorWidth: 20, floorHeight: 15 });
  const apNodeA = createApNode(db, venueA.id, { apNodeId: "ap-1", x: 0, y: 0 });

  const ownerB = createOwner(db, "Owner B");
  const venueB = createVenue(db, ownerB.id, { name: "Venue B", floorWidth: 20, floorHeight: 15 });
  createApNode(db, venueB.id, { apNodeId: "ap-1", x: 0, y: 0 });

  const groundTruthA: CalibrationProfile = { referenceRssiAt1m: -38, pathLossExponent: 2.2 };
  for (const distance of [1, 2, 4, 8, 16]) {
    recordCalibrationSample(db, {
      tenantId: ownerA.id,
      venueId: venueA.id,
      apNodeId: apNodeA.apNodeId,
      rssi: rssiAtDistance(distance, groundTruthA),
      knownX: distance,
      knownY: 0,
    });
  }

  const fittedA = fitCalibrationProfile(db, ownerA.id, venueA.id);
  assert.ok(fittedA);
  assert.ok(Math.abs(fittedA.referenceRssiAt1m - groundTruthA.referenceRssiAt1m) < 1e-6);

  // Owner B has recorded no samples at all — must get the default, never owner A's fit,
  // even though both venues happen to use the identical ap-node id "ap-1".
  const profileB = getCalibrationProfile(db, ownerB.id, venueB.id);
  assert.deepStrictEqual(profileB, DEFAULT_CALIBRATION_PROFILE);

  const fittedB = fitCalibrationProfile(db, ownerB.id, venueB.id);
  assert.strictEqual(fittedB, null);
  db.close();
});

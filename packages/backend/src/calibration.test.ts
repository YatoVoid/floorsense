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
  MIN_CALIBRATION_SAMPLES_PER_AP_NODE,
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

  // Owner B has no samples, so this must be the default, not owner A's fit (both venues use ap-node id "ap-1").
  const profileB = getCalibrationProfile(db, ownerB.id, venueB.id);
  assert.deepStrictEqual(profileB, DEFAULT_CALIBRATION_PROFILE);

  const fittedB = fitCalibrationProfile(db, ownerB.id, venueB.id);
  assert.strictEqual(fittedB, null);
  db.close();
});

test("fitCalibrationProfile fits a DIFFERENT reference RSSI per AP node when their true transmit power differs, sharing one path-loss exponent", () => {
  const db = openDatabase(":memory:");
  const owner = createOwner(db, "Per-AP Test Owner");
  const venue = createVenue(db, owner.id, { name: "Per-AP Test Venue", floorWidth: 20, floorHeight: 15 });
  const strongAp = createApNode(db, venue.id, { apNodeId: "strong-ap", x: 0, y: 0 });
  const weakAp = createApNode(db, venue.id, { apNodeId: "weak-ap", x: 0, y: 0 });

  const sharedPathLossExponent = 2.7;
  const strongProfile: CalibrationProfile = { referenceRssiAt1m: -30, pathLossExponent: sharedPathLossExponent };
  const weakProfile: CalibrationProfile = { referenceRssiAt1m: -50, pathLossExponent: sharedPathLossExponent };

  for (const distance of [1, 2, 4, 8, 16]) {
    recordCalibrationSample(db, {
      tenantId: owner.id,
      venueId: venue.id,
      apNodeId: strongAp.apNodeId,
      rssi: rssiAtDistance(distance, strongProfile),
      knownX: distance,
      knownY: 0,
    });
    recordCalibrationSample(db, {
      tenantId: owner.id,
      venueId: venue.id,
      apNodeId: weakAp.apNodeId,
      rssi: rssiAtDistance(distance, weakProfile),
      knownX: distance,
      knownY: 0,
    });
  }

  const fitted = fitCalibrationProfile(db, owner.id, venue.id);
  assert.ok(fitted);
  assert.ok(fitted.perApNodeReferenceRssi, "expected per-AP-node overrides with 5 samples per AP");
  assert.ok(
    Math.abs(fitted.perApNodeReferenceRssi!["strong-ap"]! - strongProfile.referenceRssiAt1m) < 1e-6,
    "the strong AP must recover ITS OWN reference RSSI, not a blended average with the weak one"
  );
  assert.ok(
    Math.abs(fitted.perApNodeReferenceRssi!["weak-ap"]! - weakProfile.referenceRssiAt1m) < 1e-6,
    "the weak AP must recover ITS OWN reference RSSI, not a blended average with the strong one"
  );
  db.close();
});

test("fitCalibrationProfile: an AP node below MIN_CALIBRATION_SAMPLES_PER_AP_NODE gets no per-AP override, falling back to the shared value", () => {
  const db = openDatabase(":memory:");
  const owner = createOwner(db, "Sparse AP Test Owner");
  const venue = createVenue(db, owner.id, { name: "Sparse AP Test Venue", floorWidth: 20, floorHeight: 15 });
  const wellSampledAp = createApNode(db, venue.id, { apNodeId: "well-sampled-ap", x: 0, y: 0 });
  const sparseAp = createApNode(db, venue.id, { apNodeId: "sparse-ap", x: 5, y: 0 });

  const profile: CalibrationProfile = { referenceRssiAt1m: -40, pathLossExponent: 2.7 };
  for (const distance of [1, 2, 4, 8, 16]) {
    recordCalibrationSample(db, {
      tenantId: owner.id,
      venueId: venue.id,
      apNodeId: wellSampledAp.apNodeId,
      rssi: rssiAtDistance(distance, profile),
      knownX: distance,
      knownY: 0,
    });
  }
  assert.ok(MIN_CALIBRATION_SAMPLES_PER_AP_NODE > 1, "sanity check on the exported constant");
  recordCalibrationSample(db, {
    tenantId: owner.id,
    venueId: venue.id,
    apNodeId: sparseAp.apNodeId,
    rssi: rssiAtDistance(3, profile),
    knownX: 8,
    knownY: 0,
  });

  const fitted = fitCalibrationProfile(db, owner.id, venue.id);
  assert.ok(fitted);
  assert.ok(fitted.perApNodeReferenceRssi?.["well-sampled-ap"] !== undefined, "5 samples must be enough for its own override");
  assert.strictEqual(
    fitted.perApNodeReferenceRssi?.["sparse-ap"],
    undefined,
    "1 sample is below MIN_CALIBRATION_SAMPLES_PER_AP_NODE, so no per-AP override should exist for it"
  );
  db.close();
});

test("fitCalibrationProfile: a single wild outlier sample does not drag the fit away from the true values", () => {
  const db = openDatabase(":memory:");
  const { tenantId, venueId, apNode } = setupTenant(db);
  const groundTruth: CalibrationProfile = { referenceRssiAt1m: -40, pathLossExponent: 2.7 };

  for (const distance of [1, 2, 3, 4, 5, 6, 7, 8]) {
    recordCalibrationSample(db, {
      tenantId,
      venueId,
      apNodeId: apNode.apNodeId,
      rssi: rssiAtDistance(distance, groundTruth),
      knownX: distance,
      knownY: 0,
    });
  }
  // A clearly wrong reading at a distance already well within the sampled
  // range (not an extrapolated extreme) - e.g. a stray reflection or a
  // mis-marked position, off by ~26dB against an expected ~-56dB at 4m.
  recordCalibrationSample(db, {
    tenantId,
    venueId,
    apNodeId: apNode.apNodeId,
    rssi: -30,
    knownX: 4,
    knownY: 0,
  });

  const fitted = fitCalibrationProfile(db, tenantId, venueId);
  assert.ok(fitted);
  assert.ok(
    Math.abs(fitted.referenceRssiAt1m - groundTruth.referenceRssiAt1m) < 1,
    `expected the outlier-robust fit close to the true reference RSSI, got ${fitted.referenceRssiAt1m}`
  );
  assert.ok(
    Math.abs(fitted.pathLossExponent - groundTruth.pathLossExponent) < 0.3,
    `expected the outlier-robust fit close to the true path-loss exponent, got ${fitted.pathLossExponent}`
  );
  db.close();
});

import assert from "node:assert";
import { test } from "node:test";
import type { ReturnVisitStats } from "./returnVisits.ts";
import { openDatabase } from "./db.ts";
import { createOwner } from "./tenancy.ts";
import { createOwnerWithPassword } from "./auth.ts";
import { setOwnerTier, getOwnerTier, tierAllowsHeatmap, applyTierToReturnVisitStats } from "./tiers.ts";

const SAMPLE_STATS: ReturnVisitStats = {
  perDevice: [
    {
      hashedDeviceId: "device-1",
      visitCount: 2,
      averageDwellTimeMs: 4000,
      firstSeenAt: 1000,
      lastSeenAt: 5000,
      isReturning: true,
    },
    {
      hashedDeviceId: "device-2",
      visitCount: 1,
      averageDwellTimeMs: 2000,
      firstSeenAt: 2000,
      lastSeenAt: 2500,
      isReturning: false,
    },
  ],
  newDeviceCount: 1,
  returningDeviceCount: 1,
  returningRatio: 0.5,
  hourOfDayDistribution: new Array(24).fill(0).map((_, i) => (i === 14 ? 2 : 0)),
};

test("tierAllowsHeatmap: basic is denied, standard and premium are allowed", () => {
  assert.strictEqual(tierAllowsHeatmap("basic"), false);
  assert.strictEqual(tierAllowsHeatmap("standard"), true);
  assert.strictEqual(tierAllowsHeatmap("premium"), true);
});

test("applyTierToReturnVisitStats: basic strips perDevice and zeroes hourOfDayDistribution as a real 24-length array", () => {
  const result = applyTierToReturnVisitStats(SAMPLE_STATS, "basic");
  assert.deepStrictEqual(result.perDevice, []);
  assert.strictEqual(result.hourOfDayDistribution.length, 24, "must be a real 24-length array, never omitted/empty");
  assert.ok(
    result.hourOfDayDistribution.every((v) => v === 0),
    "every bucket must be zeroed for basic"
  );
});

test("applyTierToReturnVisitStats: standard strips perDevice but keeps the real hourOfDayDistribution", () => {
  const result = applyTierToReturnVisitStats(SAMPLE_STATS, "standard");
  assert.deepStrictEqual(result.perDevice, []);
  assert.deepStrictEqual(result.hourOfDayDistribution, SAMPLE_STATS.hourOfDayDistribution);
});

test("applyTierToReturnVisitStats: premium returns the stats fully unredacted", () => {
  const result = applyTierToReturnVisitStats(SAMPLE_STATS, "premium");
  assert.deepStrictEqual(result, SAMPLE_STATS);
});

test("applyTierToReturnVisitStats: aggregate counts are identical across all three tiers for the same input", () => {
  const basic = applyTierToReturnVisitStats(SAMPLE_STATS, "basic");
  const standard = applyTierToReturnVisitStats(SAMPLE_STATS, "standard");
  const premium = applyTierToReturnVisitStats(SAMPLE_STATS, "premium");

  for (const result of [basic, standard, premium]) {
    assert.strictEqual(result.newDeviceCount, SAMPLE_STATS.newDeviceCount);
    assert.strictEqual(result.returningDeviceCount, SAMPLE_STATS.returningDeviceCount);
    assert.strictEqual(result.returningRatio, SAMPLE_STATS.returningRatio);
  }
});

test("setOwnerTier/getOwnerTier round-trip through the real database", () => {
  const db = openDatabase(":memory:");
  const owner = createOwner(db, "Tier Test Owner");

  assert.strictEqual(getOwnerTier(db, owner.id), "basic", "default tier before any explicit assignment");

  setOwnerTier(db, owner.id, "premium");
  assert.strictEqual(getOwnerTier(db, owner.id), "premium");
  db.close();
});

test("an owner created via createOwnerWithPassword (no explicit tier) defaults to basic via the schema default", () => {
  const db = openDatabase(":memory:");
  const owner = createOwnerWithPassword(db, "Password Owner No Tier", "some-password");
  assert.strictEqual(getOwnerTier(db, owner.id), "basic");
  db.close();
});

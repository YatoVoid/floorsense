import assert from "node:assert";
import { test } from "node:test";
import { runOnboardingDemo } from "./onboardingDemo.ts";

test("a brand-new owner can register, create a venue, and immediately reach the existing analytics endpoints, with zero pre-seeded data", async () => {
  const result = await runOnboardingDemo();

  assert.strictEqual(result.registerStatus, 201);
  assert.strictEqual(result.venueCreateStatus, 201);
  assert.strictEqual(result.venuesAfterCreation, 1);
  // A brand-new owner defaults to "basic" tier (KR7's schema default) — the
  // heatmap route correctly 402s rather than crashing or erroring; this is
  // proof the onboarding path integrates correctly with existing tier
  // gating, not a bug in either KR.
  assert.strictEqual(result.heatmapStatus, 402);
  assert.strictEqual(result.statsStatus, 200);
});

import assert from "node:assert";
import { test } from "node:test";
import { runOnboardingDemo } from "./onboardingDemo.ts";

test("a brand-new owner can register, create a venue, and immediately reach the existing analytics endpoints, with zero pre-seeded data", async () => {
  const result = await runOnboardingDemo();

  assert.strictEqual(result.registerStatus, 201);
  assert.strictEqual(result.venueCreateStatus, 201);
  assert.strictEqual(result.venuesAfterCreation, 1);
  // new owners default to basic tier, so the heatmap route correctly 402s
  assert.strictEqual(result.heatmapStatus, 402);
  assert.strictEqual(result.statsStatus, 200);
});

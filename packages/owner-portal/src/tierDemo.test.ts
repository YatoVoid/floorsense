import assert from "node:assert";
import { test } from "node:test";
import { runTierDemo } from "./tierDemo.ts";

test("the three tiers produce real, distinct HTTP status/body differences for identical underlying data", async () => {
  const result = await runTierDemo();

  assert.strictEqual(result.basic.heatmapStatus, 402);
  assert.strictEqual(result.standard.heatmapStatus, 200);
  assert.strictEqual(result.premium.heatmapStatus, 200);

  assert.strictEqual(result.basic.statsPerDeviceCount, 0);
  assert.strictEqual(result.standard.statsPerDeviceCount, 0);
  assert.strictEqual(result.premium.statsPerDeviceCount, 1);

  assert.strictEqual(result.basic.statsHourOfDayTotal, 0, "basic's hourOfDayDistribution must be zeroed");
  assert.ok(result.standard.statsHourOfDayTotal > 0, "standard must see the real hour-of-day pattern");
  assert.ok(result.premium.statsHourOfDayTotal > 0, "premium must see the real hour-of-day pattern");

  // Aggregate counts must be identical across all three tiers — same underlying data, only detail differs.
  assert.strictEqual(result.basic.statsNewDeviceCount, result.standard.statsNewDeviceCount);
  assert.strictEqual(result.standard.statsNewDeviceCount, result.premium.statsNewDeviceCount);
});

import assert from "node:assert";
import { test } from "node:test";
import { runHeatmapDemo } from "./heatmapDemo.ts";

test("the concentrated device's location is the hottest cell in the heatmap, and both devices appear in return-visit stats", async () => {
  const result = await runHeatmapDemo();
  assert.ok(result.totalCells > 0);
  assert.strictEqual(result.hottestCell.cellX, 7);
  assert.strictEqual(result.hottestCell.cellY, 7);
  assert.strictEqual(result.returnVisitStatsDeviceCount, 2);
});

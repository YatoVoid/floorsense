import assert from "node:assert";
import { test } from "node:test";
import { runDashboardDemo } from "./dashboardDemo.ts";

test("the dashboard's data contract holds end-to-end for both a premium and a basic owner", async () => {
  const result = await runDashboardDemo();

  assert.strictEqual(result.dashboardPageStatus, 200);
  assert.strictEqual(result.dashboardPageIsHtml, true);
  assert.strictEqual(result.dashboardPageHasVisualPolish, true, "served page must contain the section-card/button styling classes");

  assert.strictEqual(result.premiumOwner.venueCount, 1);
  assert.strictEqual(result.premiumOwner.heatmapStatus, 200);
  assert.strictEqual(result.premiumOwner.statsPerDeviceCount, 1);

  assert.strictEqual(result.basicOwner.venueCount, 1);
  assert.strictEqual(result.basicOwner.heatmapStatus, 402);
  assert.strictEqual(result.basicOwner.statsPerDeviceCount, 0);
});

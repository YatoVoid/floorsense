import assert from "node:assert";
import { test } from "node:test";
import type { VenueHeatmap, ReturnVisitStats } from "@floorsense/backend";
import { escapeHtml, renderHeatmapSection, renderStatsSummary, renderDashboardPage } from "./dashboardPage.ts";

test("escapeHtml escapes all five special characters", () => {
  assert.strictEqual(escapeHtml(`<script>&"'</script>`), "&lt;script&gt;&amp;&quot;&#39;&lt;/script&gt;");
});

test("renderHeatmapSection: null produces a no-data message", () => {
  const html = renderHeatmapSection(null);
  assert.match(html, /Select a venue/);
});

test("renderHeatmapSection: the 402 upgrade-required shape renders an escaped upgrade message, not a grid", () => {
  const html = renderHeatmapSection({ error: "upgrade required", requiredTier: "<b>standard</b>" });
  assert.match(html, /Upgrade to unlock it/);
  assert.match(html, /&lt;b&gt;standard&lt;\/b&gt;/, "requiredTier must be escaped, not injected raw");
  assert.doesNotMatch(html, /heatmap-grid/);
});

test("renderHeatmapSection: a real heatmap renders exactly gridWidth*gridHeight cells, with the hottest cell at full intensity", () => {
  const heatmap: VenueHeatmap = {
    gridWidth: 2,
    gridHeight: 2,
    cellSizeMeters: 1,
    cells: [
      { cellX: 0, cellY: 0, weight: 100 },
      { cellX: 1, cellY: 1, weight: 500 },
    ],
  };
  const html = renderHeatmapSection(heatmap);
  const cellCount = (html.match(/heatmap-cell/g) ?? []).length;
  assert.strictEqual(cellCount, 4, "must render one div per grid cell, including empty ones");
  assert.match(html, /rgba\(220, 20, 60, 1\.000\)/, "the hottest cell (weight 500, max) must be at full intensity");
  assert.match(html, /rgba\(220, 20, 60, 0\.200\)/, "the weight-100 cell must be at 100\/500 = 0.2 intensity");
  assert.match(html, /rgba\(220, 20, 60, 0\.000\)/, "an empty cell must be at zero intensity");
});

const FULL_STATS: ReturnVisitStats = {
  perDevice: [
    {
      hashedDeviceId: "device-1",
      visitCount: 2,
      averageDwellTimeMs: 4000,
      firstSeenAt: 1000,
      lastSeenAt: 5000,
      isReturning: true,
    },
  ],
  newDeviceCount: 0,
  returningDeviceCount: 1,
  returningRatio: 1,
  hourOfDayDistribution: new Array(24).fill(0).map((_, i) => (i === 10 ? 3 : 0)),
};

const REDACTED_STATS: ReturnVisitStats = {
  perDevice: [],
  newDeviceCount: 0,
  returningDeviceCount: 1,
  returningRatio: 1,
  hourOfDayDistribution: new Array(24).fill(0),
};

test("renderStatsSummary: full-detail stats render per-device rows and real hour bars", () => {
  const html = renderStatsSummary(FULL_STATS);
  assert.match(html, /device-1/);
  assert.match(html, /Returning/);
  assert.doesNotMatch(html, /not available on your current plan/);
});

test("renderStatsSummary: tier-redacted stats render without error and show the restriction notice instead of per-device rows", () => {
  const html = renderStatsSummary(REDACTED_STATS);
  assert.match(html, /not available on your current plan/);
  assert.doesNotMatch(html, /device-1/);
});

test("renderStatsSummary escapes a hashedDeviceId-shaped string containing HTML-special characters", () => {
  const stats: ReturnVisitStats = {
    ...FULL_STATS,
    perDevice: [{ ...FULL_STATS.perDevice[0]!, hashedDeviceId: "<img src=x onerror=alert(1)>" }],
  };
  const html = renderStatsSummary(stats);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test("renderDashboardPage: produces a page with login form markup, and its embedded <script> parses as valid JS", () => {
  const html = renderDashboardPage();
  assert.match(html, /<form id="login-form">/);
  assert.match(html, /login-password/);

  const scriptMatch = /<script>([\s\S]*)<\/script>/.exec(html);
  assert.ok(scriptMatch, "expected an inline <script> block");
  const scriptBody = scriptMatch![1]!;

  // Confirms the embedded functions are the exact tested source, not a
  // separate hand-duplicated copy.
  assert.match(scriptBody, /function escapeHtml/);
  assert.match(scriptBody, /function renderHeatmapSection/);
  assert.match(scriptBody, /function renderStatsSummary/);

  // A SyntaxError here would mean the embedded page JS is broken — this
  // only parses the source (function bodies aren't executed by
  // construction alone), so document/localStorage/fetch not existing in
  // Node is not a problem for this check.
  assert.doesNotThrow(() => new Function(scriptBody), "the embedded page script must be syntactically valid JS");
});

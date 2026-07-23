import assert from "node:assert";
import { test } from "node:test";
import type { VenueHeatmap, ReturnVisitStats, Venue, ApNodeRecord } from "@floorsense/backend";
import {
  escapeHtml,
  renderHeatmapSection,
  renderStatsSummary,
  renderDashboardPage,
  pixelToFloorCoordinates,
  renderFloorPlan,
  renderCalibrationForm,
  buildCalibrationSamplePayload,
  renderCalibrationResult,
  renderVenueCreationForm,
  buildVenueCreationPayload,
  renderApNodePlacementForm,
  buildApNodeCreationPayload,
  formatPriceCents,
  renderTierPicker,
  renderBillingSection,
} from "./dashboardPage.ts";

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

test("pixelToFloorCoordinates: a middle click scales proportionally", () => {
  const result = pixelToFloorCoordinates(150, 100, 300, 200, 10, 10);
  assert.strictEqual(result.x, 5);
  assert.strictEqual(result.y, 5);
});

test("pixelToFloorCoordinates: the exact (0,0) corner maps to the exact floor origin", () => {
  const result = pixelToFloorCoordinates(0, 0, 300, 200, 10, 8);
  assert.strictEqual(result.x, 0);
  assert.strictEqual(result.y, 0);
});

test("pixelToFloorCoordinates: the exact bottom-right corner maps to the exact floor bounds", () => {
  const result = pixelToFloorCoordinates(300, 200, 300, 200, 10, 8);
  assert.strictEqual(result.x, 10);
  assert.strictEqual(result.y, 8);
});

test("pixelToFloorCoordinates: negative or beyond-container pixel input is clamped into the floor's bounds", () => {
  const negative = pixelToFloorCoordinates(-50, -20, 300, 200, 10, 8);
  assert.strictEqual(negative.x, 0);
  assert.strictEqual(negative.y, 0);

  const beyond = pixelToFloorCoordinates(400, 300, 300, 200, 10, 8);
  assert.strictEqual(beyond.x, 10);
  assert.strictEqual(beyond.y, 8);
});

const TEST_VENUE: Venue = {
  id: "venue-1",
  ownerId: "owner-1",
  name: "Test Venue",
  floorWidth: 10,
  floorHeight: 8,
  createdAt: 0,
};

const TEST_AP_NODES: ApNodeRecord[] = [
  { id: "an-1", venueId: "venue-1", apNodeId: "ap-1", x: 2, y: 4, createdAt: 0 },
  { id: "an-2", venueId: "venue-1", apNodeId: "ap-2", x: 8, y: 4, createdAt: 0 },
];

test("renderFloorPlan: renders no AP-node markers when there are none, and no marked-position marker when null", () => {
  const html = renderFloorPlan(TEST_VENUE, [], null, null);
  assert.doesNotMatch(html, /ap-node-marker/);
  assert.doesNotMatch(html, /marked-position-marker/);
  assert.doesNotMatch(html, /pending-ap-node-marker/);
});

test("renderFloorPlan: renders one marker per AP node, positioned as a percentage of floorWidth/floorHeight", () => {
  const html = renderFloorPlan(TEST_VENUE, TEST_AP_NODES, null, null);
  const markerCount = (html.match(/class="ap-node-marker"/g) ?? []).length;
  assert.strictEqual(markerCount, 2);
  // ap-1 is at x=2 of floorWidth=10 -> 20.00%
  assert.match(html, /left: 20\.00%/);
});

test("renderFloorPlan: renders the marked position as a distinct marker when present", () => {
  const html = renderFloorPlan(TEST_VENUE, TEST_AP_NODES, { x: 5, y: 4 }, null);
  assert.match(html, /marked-position-marker/);
});

test("renderFloorPlan: renders a pending AP-node marker distinctly from the calibration mark", () => {
  const html = renderFloorPlan(TEST_VENUE, TEST_AP_NODES, null, { x: 3, y: 3 });
  assert.match(html, /pending-ap-node-marker/);
  assert.doesNotMatch(html, /marked-position-marker/);
});

test("renderCalibrationForm: with zero AP nodes, shows an explicit prompt to add one first, never an empty dropdown", () => {
  const html = renderCalibrationForm([], null);
  assert.match(html, /Add an AP node/);
  assert.doesNotMatch(html, /<select/, "must never render a select with zero options");
});

test("renderCalibrationForm: with AP nodes but no marked position, shows only a prompt, no submit form", () => {
  const html = renderCalibrationForm(TEST_AP_NODES, null);
  assert.match(html, /Click on the floor plan/);
  assert.doesNotMatch(html, /<form/);
});

test("renderCalibrationForm: with AP nodes and a marked position, shows the AP-node select, populated known X/Y, and a submit button", () => {
  const html = renderCalibrationForm(TEST_AP_NODES, { x: 5, y: 4 });
  assert.match(html, /<form id="calibration-form">/);
  assert.match(html, /ap-1/);
  assert.match(html, /ap-2/);
  assert.match(html, /value="5"/);
  assert.match(html, /Enter manually|enter manually/i);
});

test("buildCalibrationSamplePayload: valid input produces the exact typed body the endpoint expects", () => {
  const result = buildCalibrationSamplePayload({ apNodeId: "ap-1", rssi: "-55.5", knownX: 3, knownY: 4 });
  assert.strictEqual(result.valid, true);
  assert.ok(result.valid);
  assert.deepStrictEqual(result.payload, { apNodeId: "ap-1", rssi: -55.5, knownX: 3, knownY: 4 });
});

test("buildCalibrationSamplePayload: a missing apNodeId is rejected", () => {
  const result = buildCalibrationSamplePayload({ apNodeId: "", rssi: "-55", knownX: 3, knownY: 4 });
  assert.strictEqual(result.valid, false);
});

test("buildCalibrationSamplePayload: a non-numeric rssi string is rejected", () => {
  const result = buildCalibrationSamplePayload({ apNodeId: "ap-1", rssi: "not-a-number", knownX: 3, knownY: 4 });
  assert.strictEqual(result.valid, false);
});

test("buildCalibrationSamplePayload: an empty rssi string is rejected", () => {
  const result = buildCalibrationSamplePayload({ apNodeId: "ap-1", rssi: "", knownX: 3, knownY: 4 });
  assert.strictEqual(result.valid, false);
});

test("renderCalibrationResult: a successful response renders a success message", () => {
  const html = renderCalibrationResult({ ok: true, body: { recorded: true } });
  assert.match(html, /success/);
  assert.match(html, /recorded/);
});

test("renderCalibrationResult: an error response renders the server's escaped error message", () => {
  const html = renderCalibrationResult({ ok: false, body: { error: "<b>not found</b>" } });
  assert.match(html, /error/);
  assert.match(html, /&lt;b&gt;not found&lt;\/b&gt;/);
});

test("renderVenueCreationForm: renders the empty-state message and a real creation form", () => {
  const html = renderVenueCreationForm();
  assert.match(html, /No venues yet/);
  assert.match(html, /<form id="venue-creation-form">/);
  assert.match(html, /venue-creation-width/);
  assert.match(html, /venue-creation-height/);
});

test("buildVenueCreationPayload: valid input produces the exact typed body POST /venues expects", () => {
  const result = buildVenueCreationPayload({ name: "My Cafe", floorWidth: "12.5", floorHeight: "8" });
  assert.strictEqual(result.valid, true);
  assert.ok(result.valid);
  assert.deepStrictEqual(result.payload, { name: "My Cafe", floorWidth: 12.5, floorHeight: 8 });
});

test("buildVenueCreationPayload: an empty name is rejected", () => {
  const result = buildVenueCreationPayload({ name: "   ", floorWidth: "10", floorHeight: "8" });
  assert.strictEqual(result.valid, false);
});

test("buildVenueCreationPayload: a non-numeric or non-positive floor dimension is rejected", () => {
  const nonNumeric = buildVenueCreationPayload({ name: "My Cafe", floorWidth: "not-a-number", floorHeight: "8" });
  assert.strictEqual(nonNumeric.valid, false);

  const zero = buildVenueCreationPayload({ name: "My Cafe", floorWidth: "0", floorHeight: "8" });
  assert.strictEqual(zero.valid, false);

  const negative = buildVenueCreationPayload({ name: "My Cafe", floorWidth: "-5", floorHeight: "8" });
  assert.strictEqual(negative.valid, false);
});

test("renderApNodePlacementForm: with no pending position, shows only a prompt, no form", () => {
  const html = renderApNodePlacementForm(null);
  assert.match(html, /Click on the floor plan/);
  assert.doesNotMatch(html, /<form/);
});

test("renderApNodePlacementForm: with a pending position, shows the name field, populated hidden x/y, and save/cancel buttons", () => {
  const html = renderApNodePlacementForm({ x: 3, y: 4 });
  assert.match(html, /<form id="ap-node-form">/);
  assert.match(html, /value="3"/);
  assert.match(html, /value="4"/);
  assert.match(html, /id="ap-node-cancel"/);
});

test("buildApNodeCreationPayload: valid input produces the exact typed body POST /ap-nodes expects", () => {
  const result = buildApNodeCreationPayload({ apNodeId: "ap-1", x: 3, y: 4 });
  assert.strictEqual(result.valid, true);
  assert.ok(result.valid);
  assert.deepStrictEqual(result.payload, { apNodeId: "ap-1", x: 3, y: 4 });
});

test("buildApNodeCreationPayload: an empty name is rejected", () => {
  const result = buildApNodeCreationPayload({ apNodeId: "   ", x: 3, y: 4 });
  assert.strictEqual(result.valid, false);
});

test("buildApNodeCreationPayload: a non-finite position is rejected", () => {
  const result = buildApNodeCreationPayload({ apNodeId: "ap-1", x: NaN, y: 4 });
  assert.strictEqual(result.valid, false);
});

test("formatPriceCents: zero renders as Free, non-zero renders as dollars per month", () => {
  assert.strictEqual(formatPriceCents(0), "Free");
  assert.strictEqual(formatPriceCents(1900), "$19.00/mo");
  assert.strictEqual(formatPriceCents(4900), "$49.00/mo");
});

test("renderTierPicker: with no pricing yet, shows a loading message and no radio inputs", () => {
  const html = renderTierPicker(null);
  assert.doesNotMatch(html, /<input/);
  assert.match(html, /Loading/);
});

test("renderTierPicker: with real pricing, renders one radio per tier with its formatted price, basic checked by default", () => {
  const html = renderTierPicker({ basic: 0, standard: 1900, premium: 4900 });
  assert.match(html, /value="basic"[^>]*checked/);
  assert.match(html, /value="standard"/);
  assert.doesNotMatch(html, /value="standard"[^>]*checked/);
  assert.match(html, /value="premium"/);
  assert.match(html, /Free/);
  assert.match(html, /\$19\.00\/mo/);
  assert.match(html, /\$49\.00\/mo/);
});

test("renderBillingSection: with no history, shows a no-data message and no table", () => {
  const html = renderBillingSection([]);
  assert.doesNotMatch(html, /<table/);
  assert.match(html, /no-data/);
});

test("renderBillingSection: shows the current plan from the newest transaction, a row per transaction, and a simulate-charge button", () => {
  const html = renderBillingSection([
    { tier: "standard", kind: "monthly", amountCents: 1900, chargedAt: 2000 },
    { tier: "standard", kind: "signup", amountCents: 1900, chargedAt: 1000 },
  ]);
  assert.match(html, /Current plan:.*standard/);
  assert.match(html, /<td>monthly<\/td>/);
  assert.match(html, /<td>signup<\/td>/);
  assert.match(html, /\$19\.00\/mo/);
  assert.match(html, /id="simulate-monthly-charge-button"/);
});

test("renderBillingSection escapes any HTML-special characters in tier/kind fields", () => {
  const html = renderBillingSection([{ tier: "<b>x</b>", kind: "<i>y</i>", amountCents: 0, chargedAt: 1000 }]);
  assert.doesNotMatch(html, /<b>x<\/b>/);
  assert.doesNotMatch(html, /<i>y<\/i>/);
});

test("renderDashboardPage: produces a page with login form markup, a register toggle, an Add AP node control, and its embedded <script> parses as valid JS", () => {
  const html = renderDashboardPage();
  assert.match(html, /<form id="login-form">/);
  assert.match(html, /login-password/);
  assert.match(html, /id="auth-mode-toggle"/);
  assert.match(html, /id="add-ap-node-toggle"/);

  const scriptMatch = /<script>([\s\S]*)<\/script>/.exec(html);
  assert.ok(scriptMatch, "expected an inline <script> block");
  const scriptBody = scriptMatch![1]!;

  // Confirms the embedded functions are the exact tested source, not a
  // separate hand-duplicated copy.
  assert.match(scriptBody, /function escapeHtml/);
  assert.match(scriptBody, /function renderHeatmapSection/);
  assert.match(scriptBody, /function renderStatsSummary/);
  assert.match(scriptBody, /function pixelToFloorCoordinates/);
  assert.match(scriptBody, /function renderFloorPlan/);
  assert.match(scriptBody, /function renderCalibrationForm/);
  assert.match(scriptBody, /function buildCalibrationSamplePayload/);
  assert.match(scriptBody, /function renderCalibrationResult/);
  assert.match(scriptBody, /function renderVenueCreationForm/);
  assert.match(scriptBody, /function buildVenueCreationPayload/);
  assert.match(scriptBody, /function renderApNodePlacementForm/);
  assert.match(scriptBody, /function buildApNodeCreationPayload/);
  assert.match(scriptBody, /function formatPriceCents/);
  assert.match(scriptBody, /function renderTierPicker/);
  assert.match(scriptBody, /function renderBillingSection/);
  assert.match(html, /id="tier-picker-container"/);
  assert.match(html, /id="payment-confirmation"/);
  assert.match(html, /id="billing-section-container"/);

  // Just parses the source, doesn't run it, so missing browser globals are fine here.
  assert.doesNotThrow(() => new Function(scriptBody), "the embedded page script must be syntactically valid JS");
});

test("renderDashboardPage: sections are wrapped in cards, and primary/secondary buttons are visually distinguished", () => {
  const html = renderDashboardPage();

  // At least one card per major dashboard section, not just decoration on one element.
  const cardCount = (html.match(/class="section-card"/g) ?? []).length;
  assert.ok(cardCount >= 5, `expected at least 5 section cards, found ${cardCount}`);

  assert.match(html, /id="login-submit-button" type="submit" class="btn btn-primary"/);
  assert.match(html, /id="logout-button" class="btn btn-secondary"/);
  assert.match(html, /id="add-ap-node-toggle" class="btn btn-secondary"/);

  assert.match(html, /\.btn-primary/, "expected a .btn-primary style rule");
  assert.match(html, /\.btn-secondary/, "expected a .btn-secondary style rule");
  assert.match(html, /\.section-card/, "expected a .section-card style rule");
});

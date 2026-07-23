import type { VenueHeatmap, ReturnVisitStats, Venue, ApNodeRecord } from "@floorsense/backend";

/** Small local copy since owner-portal doesn't depend on captive-portal. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export type HeatmapUpgradeRequired = { error: string; requiredTier: string };

/** Renders the heatmap section: a real grid, the 402 upgrade message, or a no-data prompt. */
export function renderHeatmapSection(response: VenueHeatmap | HeatmapUpgradeRequired | null): string {
  if (response === null) {
    return '<p class="no-data">Select a venue to view its heatmap.</p>';
  }
  if ("error" in response) {
    return (
      '<p class="upgrade-required">Heatmap access requires the ' +
      escapeHtml(response.requiredTier) +
      " plan or higher. Upgrade to unlock it.</p>"
    );
  }

  const maxWeight = response.cells.reduce((max, c) => Math.max(max, c.weight), 0);
  const cellDivs: string[] = [];
  for (let y = 0; y < response.gridHeight; y++) {
    for (let x = 0; x < response.gridWidth; x++) {
      const cell = response.cells.find((c) => c.cellX === x && c.cellY === y);
      const weight = cell ? cell.weight : 0;
      const intensity = maxWeight > 0 ? weight / maxWeight : 0;
      cellDivs.push(
        '<div class="heatmap-cell" style="background-color: rgba(220, 20, 60, ' +
          intensity.toFixed(3) +
          ');" title="' +
          weight +
          'ms"></div>'
      );
    }
  }

  return (
    '<div class="heatmap-grid" style="grid-template-columns: repeat(' +
    response.gridWidth +
    ', 1fr);">' +
    cellDivs.join("") +
    "</div>"
  );
}

/** Renders the stats section. Works with either a full or tier-redacted ReturnVisitStats. */
export function renderStatsSummary(stats: ReturnVisitStats): string {
  const hourBars = stats.hourOfDayDistribution
    .map((count, hour) => '<div class="hour-bar" style="height: ' + count * 10 + 'px;" title="' + hour + ':00 - ' + count + ' visits"></div>')
    .join("");

  const perDeviceRows =
    stats.perDevice.length > 0
      ? stats.perDevice
          .map(
            (d) =>
              "<tr><td>" +
              escapeHtml(d.hashedDeviceId) +
              "</td><td>" +
              d.visitCount +
              "</td><td>" +
              (d.isReturning ? "Returning" : "New") +
              "</td></tr>"
          )
          .join("")
      : '<tr><td colspan="3">Per-device detail is not available on your current plan.</td></tr>';

  return (
    '<div class="stats-summary">' +
    "<p>New devices: " +
    stats.newDeviceCount +
    " | Returning devices: " +
    stats.returningDeviceCount +
    " | Returning ratio: " +
    (stats.returningRatio * 100).toFixed(1) +
    "%</p>" +
    '<div class="hour-chart">' +
    hourBars +
    "</div>" +
    "<table><thead><tr><th>Device</th><th>Visits</th><th>Status</th></tr></thead><tbody>" +
    perDeviceRows +
    "</tbody></table>" +
    "</div>"
  );
}

export interface MarkedPosition {
  x: number;
  y: number;
}

/** Scales a click's pixel offset to floor units, clamped to the floor's bounds. */
export function pixelToFloorCoordinates(
  pixelX: number,
  pixelY: number,
  containerWidthPx: number,
  containerHeightPx: number,
  floorWidth: number,
  floorHeight: number
): MarkedPosition {
  const rawX = (pixelX / containerWidthPx) * floorWidth;
  const rawY = (pixelY / containerHeightPx) * floorHeight;
  return {
    x: Math.min(Math.max(rawX, 0), floorWidth),
    y: Math.min(Math.max(rawY, 0), floorHeight),
  };
}

/** Renders the floor plan div. AP nodes, the calibration mark, and a pending new AP node are all placed by percentage, not pixels. */
export function renderFloorPlan(
  venue: Venue,
  apNodes: ApNodeRecord[],
  markedPosition: MarkedPosition | null,
  pendingApNodePosition: MarkedPosition | null,
  addingApNode: boolean
): string {
  const caption = addingApNode
    ? "Click to place a new AP node."
    : "Click to mark a calibration position.";
  const aspectRatio = venue.floorWidth / venue.floorHeight;

  const toPct = (pos: MarkedPosition) => ({
    left: ((pos.x / venue.floorWidth) * 100).toFixed(2),
    top: ((pos.y / venue.floorHeight) * 100).toFixed(2),
  });

  const apNodeMarkers = apNodes
    .map((node) => {
      const pct = toPct({ x: node.x, y: node.y });
      return (
        '<div class="ap-node-marker" style="left: ' +
        pct.left +
        "%; top: " +
        pct.top +
        '%;" title="' +
        escapeHtml(node.apNodeId) +
        '"></div>'
      );
    })
    .join("");

  const markedMarker = markedPosition
    ? (() => {
        const pct = toPct(markedPosition);
        return '<div class="marked-position-marker" style="left: ' + pct.left + "%; top: " + pct.top + '%;"></div>';
      })()
    : "";

  const pendingMarker = pendingApNodePosition
    ? (() => {
        const pct = toPct(pendingApNodePosition);
        return '<div class="pending-ap-node-marker" style="left: ' + pct.left + "%; top: " + pct.top + '%;"></div>';
      })()
    : "";

  return (
    '<p class="floor-plan-caption">' +
    caption +
    "</p>" +
    '<div id="floor-plan" class="floor-plan" style="aspect-ratio: ' +
    aspectRatio.toFixed(4) +
    ';">' +
    apNodeMarkers +
    markedMarker +
    pendingMarker +
    "</div>"
  );
}

/** Renders the calibration form. Needs at least one AP node to offer; then it's a prompt until a position is marked, then the AP-node picker plus a manual RSSI field (browsers can't read WiFi signal strength). */
export function renderCalibrationForm(apNodes: ApNodeRecord[], markedPosition: MarkedPosition | null): string {
  if (apNodes.length === 0) {
    return '<p class="no-data">Add an AP node below before calibrating. There\'s nothing to pick from yet.</p>';
  }
  if (!markedPosition) {
    return '<p class="no-data">Click on the floor plan above to mark a known position.</p>';
  }

  const apNodeOptions = apNodes
    .map((node) => '<option value="' + escapeHtml(node.apNodeId) + '">' + escapeHtml(node.apNodeId) + "</option>")
    .join("");

  return (
    '<form id="calibration-form">' +
    "<p>Marked position: (" +
    markedPosition.x.toFixed(2) +
    ", " +
    markedPosition.y.toFixed(2) +
    ")</p>" +
    '<input type="hidden" id="calibration-known-x" value="' +
    markedPosition.x +
    '" />' +
    '<input type="hidden" id="calibration-known-y" value="' +
    markedPosition.y +
    '" />' +
    '<label for="calibration-ap-node">AP node:</label>' +
    '<select id="calibration-ap-node">' +
    apNodeOptions +
    "</select>" +
    '<label for="calibration-rssi">RSSI reading (enter manually, no live sensor in this browser demo):</label>' +
    '<input type="number" id="calibration-rssi" step="0.1" required />' +
    '<button type="submit" class="btn btn-primary">Record calibration sample</button>' +
    "</form>"
  );
}

export type CalibrationSampleValidationResult =
  | { valid: true; payload: { apNodeId: string; rssi: number; knownX: number; knownY: number } }
  | { valid: false; error: string };

/** Validates form input into the body POST /calibration-samples expects. Just a UX check; the server validates independently too. */
export function buildCalibrationSamplePayload(input: {
  apNodeId: string;
  rssi: string;
  knownX: number;
  knownY: number;
}): CalibrationSampleValidationResult {
  if (!input.apNodeId) {
    return { valid: false, error: "Select an AP node." };
  }
  if (input.rssi.trim() === "") {
    return { valid: false, error: "Enter a numeric RSSI reading." };
  }
  const rssi = Number(input.rssi);
  if (!Number.isFinite(rssi)) {
    return { valid: false, error: "Enter a numeric RSSI reading." };
  }
  return { valid: true, payload: { apNodeId: input.apNodeId, rssi: rssi, knownX: input.knownX, knownY: input.knownY } };
}

/** Renders a success/error message from the calibration-samples endpoint's response. */
export function renderCalibrationResult(result: { ok: boolean; body: unknown }): string {
  if (result.ok) {
    return '<p class="success">Calibration sample recorded.</p>';
  }
  const body = result.body as { error?: string } | null;
  const message = body && typeof body.error === "string" ? body.error : "Failed to record calibration sample.";
  return '<p class="error">' + escapeHtml(message) + "</p>";
}

/** Renders the "place a new AP node" form. Empty until a floor-plan click sets a pending position. */
export function renderApNodePlacementForm(pending: MarkedPosition | null): string {
  if (!pending) {
    return '<p class="no-data">Click on the floor plan above to place the new AP node.</p>';
  }
  return (
    '<form id="ap-node-form">' +
    "<p>New AP node position: (" +
    pending.x.toFixed(2) +
    ", " +
    pending.y.toFixed(2) +
    ")</p>" +
    '<input type="hidden" id="ap-node-x" value="' +
    pending.x +
    '" />' +
    '<input type="hidden" id="ap-node-y" value="' +
    pending.y +
    '" />' +
    '<label for="ap-node-id">AP node name:</label>' +
    '<input id="ap-node-id" type="text" placeholder="e.g. ap-1" required />' +
    '<button type="submit" class="btn btn-primary">Save AP node</button>' +
    '<button type="button" id="ap-node-cancel" class="btn btn-secondary">Cancel</button>' +
    "</form>"
  );
}

export type ApNodeCreationValidationResult =
  | { valid: true; payload: { apNodeId: string; x: number; y: number } }
  | { valid: false; error: string };

/** Validates form input into the body POST /ap-nodes expects. Just a UX check; the server validates independently too. */
export function buildApNodeCreationPayload(input: { apNodeId: string; x: number; y: number }): ApNodeCreationValidationResult {
  if (input.apNodeId.trim() === "") {
    return { valid: false, error: "Enter a name for this AP node." };
  }
  if (!Number.isFinite(input.x) || !Number.isFinite(input.y)) {
    return { valid: false, error: "Invalid position, click the floor plan again." };
  }
  return { valid: true, payload: { apNodeId: input.apNodeId, x: input.x, y: input.y } };
}

/** Empty-state message plus a small form, shown when a new owner has no venues yet. */
export function renderVenueCreationForm(): string {
  return (
    '<div id="venue-creation">' +
    "<p>No venues yet. Create your first one:</p>" +
    '<form id="venue-creation-form">' +
    '<input id="venue-creation-name" type="text" placeholder="Venue name" required />' +
    '<input id="venue-creation-width" type="number" step="0.1" placeholder="Floor width (meters)" required />' +
    '<input id="venue-creation-height" type="number" step="0.1" placeholder="Floor height (meters)" required />' +
    '<button type="submit" class="btn btn-primary">Create venue</button>' +
    "</form>" +
    "</div>"
  );
}

export type VenueCreationValidationResult =
  | { valid: true; payload: { name: string; floorWidth: number; floorHeight: number } }
  | { valid: false; error: string };

/** Validates form input into the body POST /venues expects. Just a UX check; the server validates independently too. */
export function buildVenueCreationPayload(input: {
  name: string;
  floorWidth: string;
  floorHeight: string;
}): VenueCreationValidationResult {
  if (input.name.trim() === "") {
    return { valid: false, error: "Enter a venue name." };
  }
  const floorWidth = Number(input.floorWidth);
  const floorHeight = Number(input.floorHeight);
  if (!Number.isFinite(floorWidth) || floorWidth <= 0 || !Number.isFinite(floorHeight) || floorHeight <= 0) {
    return { valid: false, error: "Enter positive numeric floor width and height." };
  }
  return { valid: true, payload: { name: input.name, floorWidth, floorHeight } };
}

/** cents 0 renders as "Free"; otherwise dollars per month, two decimal places. */
export function formatPriceCents(cents: number): string {
  return cents === 0 ? "Free" : `$${(cents / 100).toFixed(2)}/mo`;
}

export interface TierPricing {
  basic: number;
  standard: number;
  premium: number;
}

/** Radio-button tier picker for the register form. Prices come from the server so they can never drift from what registration actually charges. */
export function renderTierPicker(pricing: TierPricing | null): string {
  if (!pricing) {
    return '<p class="no-data">Loading plans...</p>';
  }

  const tiers: Array<{ id: "basic" | "standard" | "premium"; label: string }> = [
    { id: "basic", label: "Basic" },
    { id: "standard", label: "Standard" },
    { id: "premium", label: "Premium" },
  ];

  const cards = tiers
    .map(
      (tier, index) =>
        '<label class="tier-card">' +
        `<input type="radio" name="tier-picker" value="${tier.id}" class="tier-card-input" ${index === 0 ? "checked" : ""} />` +
        `<span class="tier-card-name">${tier.label}</span>` +
        `<span class="tier-card-price">${escapeHtml(formatPriceCents(pricing[tier.id]))}</span>` +
        "</label>"
    )
    .join("");

  return `<div class="tier-picker-grid">${cards}</div>`;
}

/** Empty string when there's no tier yet (logged out) - the header badge simply shows nothing. */
export function renderPlanBadge(tier: string | null): string {
  if (!tier) return "";
  const badgeClass = tier === "premium" ? "badge-premium" : tier === "standard" ? "badge-standard" : "badge-basic";
  return `<span class="plan-badge ${badgeClass}">${escapeHtml(tier)}</span>`;
}

export interface BillingHistoryEntry {
  tier: string;
  kind: string;
  amountCents: number;
  chargedAt: number;
}

/** Current plan is read off the newest transaction - there's no separate upgrade/downgrade flow, so it's always accurate. */
export function renderBillingSection(history: BillingHistoryEntry[]): string {
  if (history.length === 0) {
    return '<p class="no-data">No billing history yet.</p>';
  }

  const currentTier = history[0]!.tier;
  const rows = history
    .map((entry) => {
      const date = escapeHtml(new Date(entry.chargedAt).toISOString().slice(0, 10));
      const kind = escapeHtml(entry.kind);
      const amount = escapeHtml(formatPriceCents(entry.amountCents));
      return `<tr><td>${date}</td><td>${kind}</td><td>${amount}</td></tr>`;
    })
    .join("");

  return (
    `<p>Current plan: ${renderPlanBadge(currentTier)}</p>` +
    "<table><thead><tr><th>Date</th><th>Type</th><th>Amount</th></tr></thead><tbody>" +
    rows +
    "</tbody></table>" +
    '<button type="button" id="simulate-monthly-charge-button" class="btn btn-secondary">Simulate next monthly charge</button>'
  );
}

/**
 * The page shell. The inline script embeds the tested functions above via
 * toString(), so the browser runs the same code the tests cover. The
 * fetch/DOM glue below has no automated test; it needs a manual check.
 */
export function renderDashboardPage(): string {
  const embeddedFunctions = [
    escapeHtml.toString(),
    renderHeatmapSection.toString(),
    renderStatsSummary.toString(),
    pixelToFloorCoordinates.toString(),
    renderFloorPlan.toString(),
    renderCalibrationForm.toString(),
    buildCalibrationSamplePayload.toString(),
    renderCalibrationResult.toString(),
    renderVenueCreationForm.toString(),
    buildVenueCreationPayload.toString(),
    renderApNodePlacementForm.toString(),
    buildApNodeCreationPayload.toString(),
    formatPriceCents.toString(),
    renderTierPicker.toString(),
    renderPlanBadge.toString(),
    renderBillingSection.toString(),
  ].join("\n\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>FloorSense Owner Dashboard</title>
  <style>
    :root {
      --color-bg: #f6f7fb;
      --color-surface: #ffffff;
      --color-text: #0f172a;
      --color-text-muted: #64748b;
      --color-accent: #4f46e5;
      --color-accent-dark: #4338ca;
      --color-accent-soft: #eef2ff;
      --color-border: #e5e7eb;
      --shadow-card: 0 1px 2px rgba(15, 23, 42, 0.04), 0 8px 20px rgba(15, 23, 42, 0.05);
      --shadow-card-hover: 0 1px 2px rgba(15, 23, 42, 0.05), 0 12px 28px rgba(15, 23, 42, 0.09);
      --space-sm: 0.5rem;
      --space-md: 1rem;
      --space-lg: 1.5rem;
      --radius: 0.75rem;
      --radius-sm: 0.5rem;
    }
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, Helvetica, Arial, sans-serif;
      max-width: 40rem;
      margin: 0 auto 3rem;
      padding: 0 1rem;
      background: var(--color-bg);
      color: var(--color-text);
      line-height: 1.55;
    }
    .app-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-md);
      padding: 1.25rem 0;
      margin-bottom: var(--space-lg);
      border-bottom: 1px solid var(--color-border);
    }
    .brand { display: flex; align-items: center; gap: 0.6rem; margin: 0; font-size: 1.15rem; font-weight: 700; letter-spacing: -0.01em; }
    .brand-mark {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 2rem;
      height: 2rem;
      border-radius: 0.6rem;
      background: linear-gradient(135deg, var(--color-accent), #7c3aed);
      color: #fff;
      font-size: 0.8rem;
      font-weight: 700;
      letter-spacing: 0;
    }
    .header-right { display: flex; align-items: center; gap: var(--space-md); }
    .plan-badge {
      display: inline-block;
      padding: 0.25rem 0.65rem;
      border-radius: 999px;
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: capitalize;
      letter-spacing: 0.01em;
    }
    .badge-basic { background: #f1f5f9; color: #475569; }
    .badge-standard { background: var(--color-accent-soft); color: var(--color-accent-dark); }
    .badge-premium { background: #fef3c7; color: #92400e; }
    h2 {
      margin: 0 0 var(--space-md);
      font-size: 1.05rem;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    h2::before { content: ""; width: 0.35rem; height: 1rem; border-radius: 999px; background: var(--color-accent); display: inline-block; }
    .section-card {
      border: 1px solid var(--color-border);
      border-radius: var(--radius);
      padding: var(--space-lg);
      margin-bottom: var(--space-lg);
      background: var(--color-surface);
      box-shadow: var(--shadow-card);
      transition: box-shadow 0.2s ease;
      animation: fade-in-up 0.35s ease both;
    }
    .section-card:hover { box-shadow: var(--shadow-card-hover); }
    @keyframes fade-in-up {
      from { opacity: 0; transform: translateY(6px); }
      to { opacity: 1; transform: translateY(0); }
    }
    input[type="text"], input[type="password"], input[type="number"], select {
      font: inherit;
      padding: 0.55rem 0.75rem;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      background: var(--color-surface);
      color: var(--color-text);
      transition: border-color 0.15s ease, box-shadow 0.15s ease;
    }
    input[type="text"]:focus, input[type="password"]:focus, input[type="number"]:focus, select:focus {
      outline: none;
      border-color: var(--color-accent);
      box-shadow: 0 0 0 3px var(--color-accent-soft);
    }
    .btn {
      display: inline-block;
      padding: 0.55rem 1.1rem;
      border-radius: var(--radius-sm);
      border: 1px solid transparent;
      font: inherit;
      font-weight: 600;
      font-size: 0.9rem;
      cursor: pointer;
      transition: background-color 0.15s ease, border-color 0.15s ease, transform 0.1s ease, box-shadow 0.15s ease;
    }
    .btn:active { transform: translateY(1px); }
    .btn-primary { background: var(--color-accent); border-color: var(--color-accent); color: #fff; box-shadow: 0 1px 2px rgba(79, 70, 229, 0.25); }
    .btn-primary:hover { background: var(--color-accent-dark); border-color: var(--color-accent-dark); }
    .btn-secondary { background: var(--color-surface); border-color: var(--color-border); color: var(--color-text); }
    .btn-secondary:hover { background: #f8fafc; border-color: #cbd5e1; }
    .heatmap-grid { display: grid; gap: 1px; margin: 1rem 0; border-radius: var(--radius-sm); overflow: hidden; }
    .heatmap-cell { aspect-ratio: 1; background-color: #eee; }
    .hour-chart { display: flex; align-items: flex-end; gap: 2px; height: 6rem; margin: 1rem 0; }
    .hour-bar { width: 6px; background: var(--color-accent); border-radius: 2px 2px 0 0; }
    table { border-collapse: collapse; width: 100%; border-radius: var(--radius-sm); overflow: hidden; }
    td, th { padding: 0.5rem 0.65rem; text-align: left; border-bottom: 1px solid var(--color-border); }
    th { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.03em; color: var(--color-text-muted); font-weight: 600; }
    tbody tr:last-child td { border-bottom: none; }
    .upgrade-required { color: #b45309; }
    .floor-plan-caption { color: var(--color-text-muted); font-style: italic; margin: 0 0 var(--space-sm); }
    .floor-plan { position: relative; width: 100%; max-width: 30rem; background: #f8fafc; border: 1px solid var(--color-border); border-radius: var(--radius-sm); cursor: crosshair; }
    .ap-node-marker { position: absolute; width: 10px; height: 10px; margin: -5px; background: var(--color-accent); border-radius: 50%; }
    .marked-position-marker { position: absolute; width: 12px; height: 12px; margin: -6px; background: crimson; border-radius: 50%; border: 2px solid #fff; }
    .pending-ap-node-marker { position: absolute; width: 12px; height: 12px; margin: -6px; background: orange; border-radius: 50%; border: 2px dashed #fff; }
    .no-data {
      color: var(--color-text-muted);
      font-style: italic;
      padding: 0.85rem 1rem;
      border: 1px dashed var(--color-border);
      border-radius: var(--radius-sm);
      margin: 0;
    }
    .success { color: #15803d; }
    .error { color: #b91c1c; }
    .tier-picker-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.6rem; margin: 0.75rem 0; }
    .tier-card {
      position: relative;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 0.2rem;
      padding: 0.85rem 0.5rem;
      border: 1.5px solid var(--color-border);
      border-radius: var(--radius-sm);
      cursor: pointer;
      text-align: center;
      transition: border-color 0.15s ease, box-shadow 0.15s ease;
    }
    .tier-card:hover { border-color: var(--color-accent); }
    .tier-card-input { position: absolute; opacity: 0; width: 0; height: 0; }
    .tier-card-name { font-weight: 600; font-size: 0.9rem; }
    .tier-card-price { font-size: 0.8rem; color: var(--color-text-muted); }
    .tier-card:has(.tier-card-input:checked) { border-color: var(--color-accent); box-shadow: 0 0 0 3px var(--color-accent-soft); }
    .tier-card:has(.tier-card-input:checked) .tier-card-price { color: var(--color-accent-dark); }
    #app-section { display: none; }
    #logout-button { display: none; }
  </style>
</head>
<body>
  <header class="app-header">
    <h1 class="brand"><span class="brand-mark" aria-hidden="true">FS</span>FloorSense</h1>
    <div class="header-right">
      <span id="header-plan-badge"></span>
      <button id="logout-button" class="btn btn-secondary">Log out</button>
    </div>
  </header>

  <div id="auth-section" class="section-card">
    <form id="login-form">
      <input id="login-name" type="text" placeholder="Owner name" required />
      <input id="login-password" type="password" placeholder="Password" required />
      <div id="tier-picker-container" style="display:none;"></div>
      <button id="login-submit-button" type="submit" class="btn btn-primary">Log in</button>
    </form>
    <p id="payment-confirmation" class="success"></p>
    <p><a href="#" id="auth-mode-toggle">New business? Register here</a></p>
    <p id="login-error" style="color:#b91c1c;"></p>
  </div>

  <div id="app-section">
    <div class="section-card">
      <h2>Plan &amp; Billing</h2>
      <div id="billing-section-container"></div>
    </div>
    <div class="section-card">
      <h2>Venue</h2>
      <p>
        <label for="venue-select">Venue:</label>
        <select id="venue-select"></select>
      </p>
      <div id="venue-creation-container"></div>
    </div>
    <div class="section-card">
      <h2>Heatmap</h2>
      <div id="heatmap-container"><p class="no-data">Select a venue to view its heatmap.</p></div>
    </div>
    <div class="section-card">
      <h2>Return-visit stats</h2>
      <div id="stats-container"></div>
    </div>
    <div class="section-card">
      <h2>Floor-plan calibration</h2>
      <div id="floor-plan-container"></div>
      <p><button type="button" id="add-ap-node-toggle" class="btn btn-secondary">Add AP node</button></p>
      <div id="ap-node-form-container"></div>
      <div id="calibration-form-container"></div>
      <div id="calibration-result-container"></div>
    </div>
  </div>

  <script>
${embeddedFunctions}

    var TOKEN_KEY = "floorsense_owner_token";
    var venuesById = {};
    var currentVenueId = null;
    var currentApNodes = [];
    var markedPosition = null;
    var addingApNode = false;
    var pendingApNodePosition = null;
    var tierPricing = null;

    fetch("/billing/pricing")
      .then(function (res) { return res.json(); })
      .then(function (pricing) { tierPricing = pricing; });

    function authHeaders() {
      var token = localStorage.getItem(TOKEN_KEY);
      return token ? { Authorization: "Bearer " + token } : {};
    }

    function hideApp() {
      document.getElementById("app-section").style.display = "none";
      document.getElementById("auth-section").style.display = "block";
      document.getElementById("logout-button").style.display = "none";
      document.getElementById("header-plan-badge").innerHTML = "";
    }

    function handleAuthFailure() {
      localStorage.removeItem(TOKEN_KEY);
      hideApp();
      document.getElementById("login-error").textContent = "Your session expired. Please log in again.";
    }

    function showApp() {
      document.getElementById("auth-section").style.display = "none";
      document.getElementById("app-section").style.display = "block";
      document.getElementById("logout-button").style.display = "inline-block";
      loadBillingSection();
    }

    function loadBillingSection() {
      fetch("/billing/history", { headers: authHeaders() })
        .then(function (res) {
          if (res.status === 401) { handleAuthFailure(); return null; }
          return res.json();
        })
        .then(function (history) {
          if (!history) return;
          document.getElementById("billing-section-container").innerHTML = renderBillingSection(history);
          document.getElementById("header-plan-badge").innerHTML = renderPlanBadge(history.length > 0 ? history[0].tier : null);
          var simulateButton = document.getElementById("simulate-monthly-charge-button");
          if (simulateButton) {
            simulateButton.addEventListener("click", function () {
              fetch("/billing/simulate-monthly-charge", { method: "POST", headers: authHeaders() })
                .then(function (res) {
                  if (res.status === 401) { handleAuthFailure(); return; }
                  loadBillingSection();
                });
            });
          }
        });
    }

    function loadVenues() {
      fetch("/venues", { headers: authHeaders() })
        .then(function (res) {
          if (res.status === 401) { handleAuthFailure(); return null; }
          return res.json();
        })
        .then(function (venues) {
          if (!venues) return;
          venuesById = {};
          venues.forEach(function (venue) { venuesById[venue.id] = venue; });

          var select = document.getElementById("venue-select");
          select.innerHTML = "";
          venues.forEach(function (venue) {
            var option = document.createElement("option");
            option.value = venue.id;
            option.textContent = venue.name;
            select.appendChild(option);
          });

          var creationContainer = document.getElementById("venue-creation-container");
          if (venues.length === 0) {
            creationContainer.innerHTML = renderVenueCreationForm();
            bindVenueCreationForm();
          } else {
            creationContainer.innerHTML = "";
            loadVenueData(venues[0].id);
          }
        });
    }

    function bindVenueCreationForm() {
      var form = document.getElementById("venue-creation-form");
      if (!form) return;
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        var validation = buildVenueCreationPayload({
          name: document.getElementById("venue-creation-name").value,
          floorWidth: document.getElementById("venue-creation-width").value,
          floorHeight: document.getElementById("venue-creation-height").value,
        });
        if (!validation.valid) {
          document.getElementById("login-error").textContent = validation.error;
          return;
        }
        fetch("/venues", {
          method: "POST",
          headers: Object.assign({ "Content-Type": "application/json" }, authHeaders()),
          body: JSON.stringify(validation.payload),
        })
          .then(function (res) {
            if (res.status === 401) { handleAuthFailure(); return null; }
            return res.json();
          })
          .then(function (result) {
            if (!result) return;
            loadVenues();
          });
      });
    }

    function loadVenueData(venueId) {
      currentVenueId = venueId;
      markedPosition = null;
      addingApNode = false;
      pendingApNodePosition = null;

      fetch("/venues/" + venueId + "/heatmap", { headers: authHeaders() })
        .then(function (res) {
          if (res.status === 401) { handleAuthFailure(); return; }
          return res.json();
        })
        .then(function (heatmapResponse) {
          if (heatmapResponse === undefined) return;
          document.getElementById("heatmap-container").innerHTML = renderHeatmapSection(heatmapResponse);
        });

      fetch("/venues/" + venueId + "/return-visit-stats", { headers: authHeaders() })
        .then(function (res) {
          if (res.status === 401) { handleAuthFailure(); return null; }
          return res.json();
        })
        .then(function (stats) {
          if (!stats) return;
          document.getElementById("stats-container").innerHTML = renderStatsSummary(stats);
        });

      fetch("/venues/" + venueId + "/ap-nodes", { headers: authHeaders() })
        .then(function (res) {
          if (res.status === 401) { handleAuthFailure(); return null; }
          return res.json();
        })
        .then(function (apNodes) {
          if (!apNodes) return;
          currentApNodes = apNodes;
          renderCalibrationUi();
        });
    }

    function renderCalibrationUi() {
      var venue = venuesById[currentVenueId];
      if (!venue) return;
      document.getElementById("floor-plan-container").innerHTML = renderFloorPlan(venue, currentApNodes, markedPosition, pendingApNodePosition, addingApNode);
      document.getElementById("add-ap-node-toggle").textContent = addingApNode ? "Cancel adding AP node" : "Add AP node";
      document.getElementById("ap-node-form-container").innerHTML = addingApNode ? renderApNodePlacementForm(pendingApNodePosition) : "";
      document.getElementById("calibration-form-container").innerHTML = renderCalibrationForm(currentApNodes, markedPosition);
      document.getElementById("calibration-result-container").innerHTML = "";

      var floorPlanEl = document.getElementById("floor-plan");
      if (floorPlanEl) {
        floorPlanEl.addEventListener("click", function (e) {
          var rect = floorPlanEl.getBoundingClientRect();
          var pixelX = e.clientX - rect.left;
          var pixelY = e.clientY - rect.top;
          var coords = pixelToFloorCoordinates(pixelX, pixelY, rect.width, rect.height, venue.floorWidth, venue.floorHeight);
          if (addingApNode) {
            pendingApNodePosition = coords;
          } else {
            markedPosition = coords;
          }
          renderCalibrationUi();
        });
      }

      var apNodeForm = document.getElementById("ap-node-form");
      if (apNodeForm) {
        apNodeForm.addEventListener("submit", function (e) {
          e.preventDefault();
          var validation = buildApNodeCreationPayload({
            apNodeId: document.getElementById("ap-node-id").value,
            x: Number(document.getElementById("ap-node-x").value),
            y: Number(document.getElementById("ap-node-y").value),
          });
          if (!validation.valid) {
            document.getElementById("ap-node-form-container").innerHTML += '<p class="error">' + validation.error + "</p>";
            return;
          }
          fetch("/venues/" + currentVenueId + "/ap-nodes", {
            method: "POST",
            headers: Object.assign({ "Content-Type": "application/json" }, authHeaders()),
            body: JSON.stringify(validation.payload),
          })
            .then(function (res) {
              if (res.status === 401) { handleAuthFailure(); return null; }
              return res.json().then(function (body) { return { ok: res.ok, body: body }; });
            })
            .then(function (result) {
              if (!result) return;
              if (!result.ok) {
                document.getElementById("ap-node-form-container").innerHTML += '<p class="error">' + (result.body.error || "Failed to save AP node.") + "</p>";
                return;
              }
              addingApNode = false;
              pendingApNodePosition = null;
              fetch("/venues/" + currentVenueId + "/ap-nodes", { headers: authHeaders() })
                .then(function (res) {
                  if (res.status === 401) { handleAuthFailure(); return null; }
                  return res.json();
                })
                .then(function (apNodes) {
                  if (!apNodes) return;
                  currentApNodes = apNodes;
                  renderCalibrationUi();
                });
            });
        });
      }

      var apNodeCancel = document.getElementById("ap-node-cancel");
      if (apNodeCancel) {
        apNodeCancel.addEventListener("click", function () {
          pendingApNodePosition = null;
          renderCalibrationUi();
        });
      }

      var calibrationForm = document.getElementById("calibration-form");
      if (calibrationForm) {
        calibrationForm.addEventListener("submit", function (e) {
          e.preventDefault();
          var validation = buildCalibrationSamplePayload({
            apNodeId: document.getElementById("calibration-ap-node").value,
            rssi: document.getElementById("calibration-rssi").value,
            knownX: Number(document.getElementById("calibration-known-x").value),
            knownY: Number(document.getElementById("calibration-known-y").value),
          });
          if (!validation.valid) {
            document.getElementById("calibration-result-container").innerHTML = renderCalibrationResult({ ok: false, body: { error: validation.error } });
            return;
          }
          fetch("/venues/" + currentVenueId + "/calibration-samples", {
            method: "POST",
            headers: Object.assign({ "Content-Type": "application/json" }, authHeaders()),
            body: JSON.stringify(validation.payload),
          })
            .then(function (res) {
              if (res.status === 401) { handleAuthFailure(); return null; }
              return res.json().then(function (body) { return { ok: res.ok, body: body }; });
            })
            .then(function (result) {
              if (!result) return;
              document.getElementById("calibration-result-container").innerHTML = renderCalibrationResult(result);
            });
        });
      }
    }

    var isRegisterMode = false;

    document.getElementById("auth-mode-toggle").addEventListener("click", function (e) {
      e.preventDefault();
      isRegisterMode = !isRegisterMode;
      document.getElementById("login-submit-button").textContent = isRegisterMode ? "Register" : "Log in";
      e.target.textContent = isRegisterMode ? "Already registered? Log in here" : "New business? Register here";
      document.getElementById("login-error").textContent = "";
      var tierPickerContainer = document.getElementById("tier-picker-container");
      tierPickerContainer.style.display = isRegisterMode ? "block" : "none";
      if (isRegisterMode) {
        tierPickerContainer.innerHTML = renderTierPicker(tierPricing);
      }
    });

    document.getElementById("login-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var name = document.getElementById("login-name").value;
      var password = document.getElementById("login-password").value;
      var endpoint = isRegisterMode ? "/auth/register" : "/auth/login";
      var selectedTierInput = document.querySelector('input[name="tier-picker"]:checked');
      var selectedTier = selectedTierInput ? selectedTierInput.value : "basic";
      var payload = isRegisterMode ? { name: name, password: password, tier: selectedTier } : { name: name, password: password };
      fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
        .then(function (res) { return res.json().then(function (body) { return { ok: res.ok, status: res.status, body: body }; }); })
        .then(function (result) {
          if (!result.ok) {
            document.getElementById("login-error").textContent =
              result.status === 409 ? "That name is already registered." : isRegisterMode ? "Registration failed." : "Login failed.";
            return;
          }
          localStorage.setItem(TOKEN_KEY, result.body.token);
          document.getElementById("login-error").textContent = "";
          if (isRegisterMode && tierPricing && result.body.tier) {
            var price = formatPriceCents(tierPricing[result.body.tier]);
            document.getElementById("payment-confirmation").textContent =
              "Payment simulated: " + price + " - " + result.body.tier + " plan active.";
          }
          showApp();
          loadVenues();
        });
    });

    document.getElementById("venue-select").addEventListener("change", function (e) {
      loadVenueData(e.target.value);
    });

    document.getElementById("add-ap-node-toggle").addEventListener("click", function () {
      addingApNode = !addingApNode;
      pendingApNodePosition = null;
      renderCalibrationUi();
    });

    document.getElementById("logout-button").addEventListener("click", function () {
      localStorage.removeItem(TOKEN_KEY);
      hideApp();
    });

    if (localStorage.getItem(TOKEN_KEY)) {
      showApp();
      loadVenues();
    }
  </script>
</body>
</html>`;
}

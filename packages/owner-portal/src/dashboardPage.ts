import type { VenueHeatmap, ReturnVisitStats, Venue, ApNodeRecord } from "@floorsense/backend";

/** Duplicated locally rather than importing from @floorsense/captive-portal — owner-portal has no existing dependency on that package, and this is a tiny, self-contained utility. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export type HeatmapUpgradeRequired = { error: string; requiredTier: string };

/**
 * Pure: given already-fetched JSON (or null for "nothing fetched yet"),
 * produces the heatmap section's HTML. Handles all three real response
 * shapes the /venues/:id/heatmap endpoint can return: a real VenueHeatmap
 * (KR6), the 402 upgrade-required shape (KR7), or no data yet.
 */
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

/**
 * Pure: given an already-fetched ReturnVisitStats (which may already be
 * tier-redacted by the server — empty perDevice, zeroed
 * hourOfDayDistribution, per KR7), produces the stats section's HTML.
 * Renders correctly whether given a full-detail or a redacted shape.
 */
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

/**
 * Pure geometry: scales a click's pixel offset inside the rendered
 * floor-plan container to the venue's real floorWidth x floorHeight
 * units, clamped to the floor's bounds so a click right at (or slightly
 * outside, due to rounding) the container's edge never produces an
 * out-of-bounds floor coordinate.
 */
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

/**
 * Pure: renders a floor-plan div sized to the venue's real aspect ratio,
 * with each AP node positioned as a percentage of floorWidth/floorHeight
 * (not raw pixels) — this keeps the function independent of whatever
 * pixel size the container actually renders at in a real browser. The
 * currently-marked calibration point (if any) is rendered as a distinct
 * marker.
 */
export function renderFloorPlan(venue: Venue, apNodes: ApNodeRecord[], markedPosition: MarkedPosition | null): string {
  const aspectRatio = venue.floorWidth / venue.floorHeight;

  const apNodeMarkers = apNodes
    .map((node) => {
      const leftPct = (node.x / venue.floorWidth) * 100;
      const topPct = (node.y / venue.floorHeight) * 100;
      return (
        '<div class="ap-node-marker" style="left: ' +
        leftPct.toFixed(2) +
        "%; top: " +
        topPct.toFixed(2) +
        '%;" title="' +
        escapeHtml(node.apNodeId) +
        '"></div>'
      );
    })
    .join("");

  const markedMarker = markedPosition
    ? '<div class="marked-position-marker" style="left: ' +
      ((markedPosition.x / venue.floorWidth) * 100).toFixed(2) +
      "%; top: " +
      ((markedPosition.y / venue.floorHeight) * 100).toFixed(2) +
      '%;"></div>'
    : "";

  return (
    '<div id="floor-plan" class="floor-plan" style="aspect-ratio: ' +
    aspectRatio.toFixed(4) +
    ';">' +
    apNodeMarkers +
    markedMarker +
    "</div>"
  );
}

/**
 * Pure: renders the calibration form. With no marked position yet, shows
 * only a prompt (no submit control — there is nothing to submit). Once a
 * position is marked, shows an AP-node picker, the read-only marked
 * known-X/Y (populated by the click glue, never typed by hand), a manual
 * RSSI number input explicitly labeled as manual/proof-of-concept entry
 * (browsers have no WiFi-signal-strength API, and this repo has no live
 * sensor loop feeding the dashboard — this is an honest limitation, not a
 * cut corner), and a submit button.
 */
export function renderCalibrationForm(apNodes: ApNodeRecord[], markedPosition: MarkedPosition | null): string {
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
    '<label for="calibration-rssi">RSSI reading (enter manually — no live sensor in this browser demo):</label>' +
    '<input type="number" id="calibration-rssi" step="0.1" required />' +
    '<button type="submit">Record calibration sample</button>' +
    "</form>"
  );
}

export type CalibrationSampleValidationResult =
  | { valid: true; payload: { apNodeId: string; rssi: number; knownX: number; knownY: number } }
  | { valid: false; error: string };

/**
 * Validates and coerces raw calibration-form input into the exact body
 * POST /venues/:venueId/calibration-samples already expects. This is a UX
 * nicety — catching bad input before a wasted round trip — NOT the
 * security boundary: the server independently validates the same shape
 * (KR5's existing typeof checks) and rejects a malformed body regardless
 * of what this function does. rssi arrives as a string (a DOM input's
 * .value is always a string, whatever its type attribute); knownX/knownY
 * arrive already numeric, from pixelToFloorCoordinates's own return value.
 */
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

/** Pure: renders a success/error message from the calibration-samples endpoint's existing 201/400/401/404 response shapes. */
export function renderCalibrationResult(result: { ok: boolean; body: unknown }): string {
  if (result.ok) {
    return '<p class="success">Calibration sample recorded.</p>';
  }
  const body = result.body as { error?: string } | null;
  const message = body && typeof body.error === "string" ? body.error : "Failed to record calibration sample.";
  return '<p class="error">' + escapeHtml(message) + "</p>";
}

/**
 * The static HTML shell. The inline <script> embeds the EXACT source of
 * escapeHtml/renderHeatmapSection/renderStatsSummary above via
 * Function.prototype.toString() — verified empirically that Node's
 * type-stripping produces valid (whitespace-padded) plain JS this way —
 * so the browser runs the identical, unit-tested functions rather than a
 * second, hand-duplicated (and untested) copy of the same logic. Only the
 * DOM-binding glue below (fetch calls, event listeners, localStorage) is
 * NOT unit-tested — no headless browser is introduced in this repo; that
 * glue is a stated, deliberate manual-smoke-check boundary, not silently
 * assumed to be covered.
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
  ].join("\n\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>FloorSense Owner Dashboard</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 40rem; margin: 2rem auto; padding: 0 1rem; }
    .heatmap-grid { display: grid; gap: 1px; margin: 1rem 0; }
    .heatmap-cell { aspect-ratio: 1; background-color: #eee; }
    .hour-chart { display: flex; align-items: flex-end; gap: 2px; height: 6rem; margin: 1rem 0; }
    .hour-bar { width: 6px; background: steelblue; }
    table { border-collapse: collapse; width: 100%; }
    td, th { border: 1px solid #ccc; padding: 0.25rem 0.5rem; text-align: left; }
    .upgrade-required { color: #a00; }
    .floor-plan { position: relative; width: 100%; max-width: 30rem; background: #f5f5f5; border: 1px solid #ccc; cursor: crosshair; }
    .ap-node-marker { position: absolute; width: 10px; height: 10px; margin: -5px; background: steelblue; border-radius: 50%; }
    .marked-position-marker { position: absolute; width: 12px; height: 12px; margin: -6px; background: crimson; border-radius: 50%; border: 2px solid #fff; }
    .success { color: #060; }
    .error { color: #a00; }
    #app-section { display: none; }
  </style>
</head>
<body>
  <h1>FloorSense Owner Dashboard</h1>

  <form id="login-form">
    <input id="login-name" type="text" placeholder="Owner name" required />
    <input id="login-password" type="password" placeholder="Password" required />
    <button type="submit">Log in</button>
  </form>
  <p id="login-error" style="color:#a00;"></p>

  <div id="app-section">
    <button id="logout-button">Log out</button>
    <p>
      <label for="venue-select">Venue:</label>
      <select id="venue-select"></select>
    </p>
    <h2>Heatmap</h2>
    <div id="heatmap-container"><p class="no-data">Select a venue to view its heatmap.</p></div>
    <h2>Return-visit stats</h2>
    <div id="stats-container"></div>
    <h2>Floor-plan calibration</h2>
    <div id="floor-plan-container"></div>
    <div id="calibration-form-container"></div>
    <div id="calibration-result-container"></div>
  </div>

  <script>
${embeddedFunctions}

    var TOKEN_KEY = "floorsense_owner_token";
    var venuesById = {};
    var currentVenueId = null;
    var currentApNodes = [];
    var markedPosition = null;

    function authHeaders() {
      var token = localStorage.getItem(TOKEN_KEY);
      return token ? { Authorization: "Bearer " + token } : {};
    }

    function showApp() {
      document.getElementById("login-form").style.display = "none";
      document.getElementById("app-section").style.display = "block";
    }

    function loadVenues() {
      fetch("/venues", { headers: authHeaders() })
        .then(function (res) { return res.json(); })
        .then(function (venues) {
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
          if (venues.length > 0) loadVenueData(venues[0].id);
        });
    }

    function loadVenueData(venueId) {
      currentVenueId = venueId;
      markedPosition = null;

      fetch("/venues/" + venueId + "/heatmap", { headers: authHeaders() })
        .then(function (res) { return res.json(); })
        .then(function (heatmapResponse) {
          document.getElementById("heatmap-container").innerHTML = renderHeatmapSection(heatmapResponse);
        });

      fetch("/venues/" + venueId + "/return-visit-stats", { headers: authHeaders() })
        .then(function (res) { return res.json(); })
        .then(function (stats) {
          document.getElementById("stats-container").innerHTML = renderStatsSummary(stats);
        });

      fetch("/venues/" + venueId + "/ap-nodes", { headers: authHeaders() })
        .then(function (res) { return res.json(); })
        .then(function (apNodes) {
          currentApNodes = apNodes;
          renderCalibrationUi();
        });
    }

    function renderCalibrationUi() {
      var venue = venuesById[currentVenueId];
      if (!venue) return;
      document.getElementById("floor-plan-container").innerHTML = renderFloorPlan(venue, currentApNodes, markedPosition);
      document.getElementById("calibration-form-container").innerHTML = renderCalibrationForm(currentApNodes, markedPosition);
      document.getElementById("calibration-result-container").innerHTML = "";

      var floorPlanEl = document.getElementById("floor-plan");
      if (floorPlanEl) {
        floorPlanEl.addEventListener("click", function (e) {
          var rect = floorPlanEl.getBoundingClientRect();
          var pixelX = e.clientX - rect.left;
          var pixelY = e.clientY - rect.top;
          markedPosition = pixelToFloorCoordinates(pixelX, pixelY, rect.width, rect.height, venue.floorWidth, venue.floorHeight);
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
            .then(function (res) { return res.json().then(function (body) { return { ok: res.ok, body: body }; }); })
            .then(function (result) {
              document.getElementById("calibration-result-container").innerHTML = renderCalibrationResult(result);
            });
        });
      }
    }

    document.getElementById("login-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var name = document.getElementById("login-name").value;
      var password = document.getElementById("login-password").value;
      fetch("/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name, password: password }),
      })
        .then(function (res) { return res.json().then(function (body) { return { ok: res.ok, body: body }; }); })
        .then(function (result) {
          if (!result.ok) {
            document.getElementById("login-error").textContent = "Login failed.";
            return;
          }
          localStorage.setItem(TOKEN_KEY, result.body.token);
          document.getElementById("login-error").textContent = "";
          showApp();
          loadVenues();
        });
    });

    document.getElementById("venue-select").addEventListener("change", function (e) {
      loadVenueData(e.target.value);
    });

    document.getElementById("logout-button").addEventListener("click", function () {
      localStorage.removeItem(TOKEN_KEY);
      document.getElementById("app-section").style.display = "none";
      document.getElementById("login-form").style.display = "block";
    });

    if (localStorage.getItem(TOKEN_KEY)) {
      showApp();
      loadVenues();
    }
  </script>
</body>
</html>`;
}

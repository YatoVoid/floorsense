import type { VenueHeatmap, ReturnVisitStats } from "@floorsense/backend";

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
  const embeddedFunctions = [escapeHtml.toString(), renderHeatmapSection.toString(), renderStatsSummary.toString()].join(
    "\n\n"
  );

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
  </div>

  <script>
${embeddedFunctions}

    var TOKEN_KEY = "floorsense_owner_token";

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

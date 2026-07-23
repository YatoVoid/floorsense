import assert from "node:assert";
import { test } from "node:test";
import type { ApNodePosition, CalibrationProfile } from "@floorsense/positioning";
import { hashDeviceId } from "@floorsense/shared";
import { openDatabase } from "./db.ts";
import { createOwner, createVenue, createApNode } from "./tenancy.ts";
import { recordConsentGrant } from "./consent.ts";
import { ingestApEvent } from "./ingest.ts";
import { SESSION_GAP_MS } from "./returnVisits.ts";
import {
  buildHeatmapFromEstimates,
  groupIntoSnapshots,
  computeWeightedEstimatesForDevice,
  computeVenueHeatmap,
  type Snapshot,
} from "./heatmap.ts";

const PROFILE: CalibrationProfile = { referenceRssiAt1m: -40, pathLossExponent: 2.7 };

function rssiAtDistance(distance: number): number {
  return PROFILE.referenceRssiAt1m - 10 * PROFILE.pathLossExponent * Math.log10(Math.max(distance, 0.1));
}

const TRIANGLE_AP_NODES: ApNodePosition[] = [
  { apNodeId: "ap-1", x: 0, y: 0 },
  { apNodeId: "ap-2", x: 10, y: 0 },
  { apNodeId: "ap-3", x: 5, y: 10 },
];

// ---- buildHeatmapFromEstimates (pure) ----

test("a single point's weighted time lands in the correct cell", () => {
  const heatmap = buildHeatmapFromEstimates([{ x: 3.5, y: 2.2, weightMs: 5000 }], 10, 10, 1);
  assert.strictEqual(heatmap.cells.length, 1);
  assert.strictEqual(heatmap.cells[0]?.cellX, 3);
  assert.strictEqual(heatmap.cells[0]?.cellY, 2);
  assert.strictEqual(heatmap.cells[0]?.weight, 5000);
});

test("two estimates at the same location sum into that cell's weight (venue-level aggregate, not per-device)", () => {
  const heatmap = buildHeatmapFromEstimates(
    [
      { x: 3.1, y: 2.1, weightMs: 1000 },
      { x: 3.9, y: 2.9, weightMs: 2000 },
    ],
    10,
    10,
    1
  );
  assert.strictEqual(heatmap.cells.length, 1, "both estimates fall in the same 1m cell");
  assert.strictEqual(heatmap.cells[0]?.weight, 3000, "weights must sum, not overwrite");
});

test("grid dimensions round up when floor dimensions aren't a clean multiple of cellSizeMeters", () => {
  const heatmap = buildHeatmapFromEstimates([], 10.5, 7.2, 1);
  assert.strictEqual(heatmap.gridWidth, 11);
  assert.strictEqual(heatmap.gridHeight, 8);
});

test("out-of-bounds coordinates are clamped into a valid cell, not dropped or crashed", () => {
  const heatmap = buildHeatmapFromEstimates(
    [
      { x: -5, y: -5, weightMs: 1000 },
      { x: 100, y: 100, weightMs: 1000 },
    ],
    10,
    10,
    1
  );
  assert.strictEqual(heatmap.cells.length, 2);
  for (const cell of heatmap.cells) {
    assert.ok(cell.cellX >= 0 && cell.cellX < heatmap.gridWidth);
    assert.ok(cell.cellY >= 0 && cell.cellY < heatmap.gridHeight);
  }
});

// ---- groupIntoSnapshots (pure) ----

test("groupIntoSnapshots groups readings with an identical timestamp, separates differing ones", () => {
  const rows = [
    { ap_node_id: "ap-1", rssi: -50, timestamp: 1000 },
    { ap_node_id: "ap-2", rssi: -55, timestamp: 1000 },
    { ap_node_id: "ap-1", rssi: -52, timestamp: 2000 },
  ];
  const snapshots = groupIntoSnapshots(rows);
  assert.strictEqual(snapshots.length, 2);
  assert.strictEqual(snapshots[0]?.readings.length, 2);
  assert.strictEqual(snapshots[1]?.readings.length, 1);
});

// ---- computeWeightedEstimatesForDevice (pure) ----

function snapshotAt(timestamp: number, distances: [number, number, number]): Snapshot {
  return {
    timestamp,
    readings: TRIANGLE_AP_NODES.map((node, i) => ({ apNodeId: node.apNodeId, rssi: rssiAtDistance(distances[i]) })),
  };
}

test("a snapshot's weight equals the gap to its successor, when under the cap", () => {
  const snapshots = [snapshotAt(1000, [5, 5, 5]), snapshotAt(4000, [5, 5, 5])];
  const estimates = computeWeightedEstimatesForDevice(snapshots, TRIANGLE_AP_NODES, PROFILE);
  assert.strictEqual(estimates.length, 2);
  assert.strictEqual(estimates[0]?.weightMs, 3000);
});

test("a gap exceeding SESSION_GAP_MS is capped, not left uncapped", () => {
  const snapshots = [snapshotAt(1000, [5, 5, 5]), snapshotAt(1000 + SESSION_GAP_MS + 60_000, [5, 5, 5])];
  const estimates = computeWeightedEstimatesForDevice(snapshots, TRIANGLE_AP_NODES, PROFILE);
  assert.strictEqual(estimates[0]?.weightMs, SESSION_GAP_MS);
});

test("a device's last (or only) snapshot receives weight = SESSION_GAP_MS, not zero", () => {
  const estimates = computeWeightedEstimatesForDevice([snapshotAt(1000, [5, 5, 5])], TRIANGLE_AP_NODES, PROFILE);
  assert.strictEqual(estimates.length, 1);
  assert.strictEqual(estimates[0]?.weightMs, SESSION_GAP_MS);
});

test("a no-data snapshot (unknown AP node) is excluded, without affecting the device's other snapshots", () => {
  const snapshots: Snapshot[] = [
    { timestamp: 1000, readings: [{ apNodeId: "unknown-ap", rssi: -55 }] },
    snapshotAt(2000, [5, 5, 5]),
  ];
  const estimates = computeWeightedEstimatesForDevice(snapshots, TRIANGLE_AP_NODES, PROFILE);
  assert.strictEqual(estimates.length, 1, "the no-data snapshot must be excluded, the real one kept");
});

test("a weighted-centroid snapshot (1-2 AP nodes) is included as real signal", () => {
  const snapshots: Snapshot[] = [{ timestamp: 1000, readings: [{ apNodeId: "ap-1", rssi: rssiAtDistance(2) }] }];
  const estimates = computeWeightedEstimatesForDevice(snapshots, TRIANGLE_AP_NODES, PROFILE);
  assert.strictEqual(estimates.length, 1);
});

// ---- computeVenueHeatmap (DB-backed) ----

function setupVenueWithTriangle(db: ReturnType<typeof openDatabase>) {
  const owner = createOwner(db, "Heatmap Test Owner");
  const venue = createVenue(db, owner.id, { name: "Heatmap Test Venue", floorWidth: 10, floorHeight: 10 });
  for (const node of TRIANGLE_AP_NODES) {
    createApNode(db, venue.id, { apNodeId: node.apNodeId, x: node.x, y: node.y });
  }
  return { tenantId: owner.id, venueId: venue.id };
}

test("computeVenueHeatmap: a concentrated device produces a populated grid with the expected hottest cell", () => {
  const db = openDatabase(":memory:");
  const { tenantId, venueId } = setupVenueWithTriangle(db);
  const hashedDeviceId = hashDeviceId("aa:bb:cc:dd:ee:ff", "test-salt");
  recordConsentGrant(db, { tenantId, venueId, hashedDeviceId, termsVersion: "v1" });

  // Not on an integer cell boundary, so a tiny floating-point residual can't flip which cell it floors into.
  const truth = { x: 5.5, y: 3.5 };
  let timestamp = 1000;
  for (let i = 0; i < 3; i++) {
    for (const node of TRIANGLE_AP_NODES) {
      ingestApEvent(db, {
        type: "signal_reading",
        hashedDeviceId,
        tenantId,
        venueId,
        apNodeId: node.apNodeId,
        timestamp,
        rssi: rssiAtDistance(Math.hypot(truth.x - node.x, truth.y - node.y)),
      });
    }
    timestamp += 5000;
  }

  const heatmap = computeVenueHeatmap(db, tenantId, venueId);
  assert.ok(heatmap.cells.length > 0);
  const hottest = heatmap.cells.reduce((a, b) => (b.weight > a.weight ? b : a));
  assert.strictEqual(hottest.cellX, Math.floor(truth.x));
  assert.strictEqual(hottest.cellY, Math.floor(truth.y));
  db.close();
});

test("computeVenueHeatmap: a device with no matching AP node readings contributes nothing and doesn't crash", () => {
  const db = openDatabase(":memory:");
  const { tenantId, venueId } = setupVenueWithTriangle(db);

  const heatmap = computeVenueHeatmap(db, tenantId, venueId);
  assert.strictEqual(heatmap.cells.length, 0);
  db.close();
});

test("computeVenueHeatmap is tenant-isolated: owner A's heatmap never includes owner B's events", () => {
  const db = openDatabase(":memory:");
  const { tenantId: tenantA, venueId: venueA } = setupVenueWithTriangle(db);
  const ownerB = createOwner(db, "Owner B");
  const venueB = createVenue(db, ownerB.id, { name: "Venue B", floorWidth: 10, floorHeight: 10 });
  for (const node of TRIANGLE_AP_NODES) {
    createApNode(db, venueB.id, { apNodeId: node.apNodeId, x: node.x, y: node.y });
  }

  const hashedDeviceId = hashDeviceId("aa:bb:cc:dd:ee:ff", "test-salt");
  recordConsentGrant(db, { tenantId: tenantA, venueId: venueA, hashedDeviceId, termsVersion: "v1" });
  for (const node of TRIANGLE_AP_NODES) {
    ingestApEvent(db, {
      type: "signal_reading",
      hashedDeviceId,
      tenantId: tenantA,
      venueId: venueA,
      apNodeId: node.apNodeId,
      timestamp: 1000,
      rssi: rssiAtDistance(5),
    });
  }

  const heatmapB = computeVenueHeatmap(db, ownerB.id, venueB.id);
  assert.strictEqual(heatmapB.cells.length, 0, "owner B's heatmap must not include owner A's events");
  db.close();
});

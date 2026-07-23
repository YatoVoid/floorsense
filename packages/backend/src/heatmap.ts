import type { DatabaseSync } from "node:sqlite";
import { estimateDevicePosition, type ApNodePosition, type CalibrationProfile } from "@floorsense/positioning";
import { getApNodesForVenue, getVenue } from "./tenancy.ts";
import { getCalibrationProfile } from "./calibration.ts";
import { SESSION_GAP_MS } from "./returnVisits.ts";

export interface HeatmapGridConfig {
  cellSizeMeters: number;
}

/** 1 meter per cell: fine enough to show seating clusters, coarse enough that a typical venue floor doesn't produce an enormous grid. */
export const DEFAULT_HEATMAP_CONFIG: HeatmapGridConfig = { cellSizeMeters: 1 };

export interface HeatmapCell {
  cellX: number;
  cellY: number;
  weight: number;
}

export interface VenueHeatmap {
  gridWidth: number;
  gridHeight: number;
  cellSizeMeters: number;
  cells: HeatmapCell[];
}

export interface WeightedPositionEstimate {
  x: number;
  y: number;
  weightMs: number;
}

function clampCellIndex(index: number, gridSize: number): number {
  return Math.min(Math.max(index, 0), gridSize - 1);
}

/**
 * Buckets weighted position estimates into a venue-level grid — a "most
 * sat at" spatial map summed across ALL devices per cell, not one device's
 * individual path. Pure, independently testable without a live DB (same
 * split as estimateDevicePosition/positioning.ts).
 *
 * Grid dimensions round UP (ceil) when floorWidth/floorHeight aren't a
 * clean multiple of cellSizeMeters, so the whole floor is always covered;
 * the final row/column simply represents a smaller physical area than a
 * full cell, an acceptable approximation for a heatmap.
 */
export function buildHeatmapFromEstimates(
  estimates: WeightedPositionEstimate[],
  floorWidth: number,
  floorHeight: number,
  cellSizeMeters: number = DEFAULT_HEATMAP_CONFIG.cellSizeMeters
): VenueHeatmap {
  const gridWidth = Math.max(1, Math.ceil(floorWidth / cellSizeMeters));
  const gridHeight = Math.max(1, Math.ceil(floorHeight / cellSizeMeters));

  const weights = new Map<string, number>();
  for (const estimate of estimates) {
    const cellX = clampCellIndex(Math.floor(estimate.x / cellSizeMeters), gridWidth);
    const cellY = clampCellIndex(Math.floor(estimate.y / cellSizeMeters), gridHeight);
    const key = `${cellX},${cellY}`;
    weights.set(key, (weights.get(key) ?? 0) + estimate.weightMs);
  }

  const cells: HeatmapCell[] = [];
  for (const [key, weight] of weights) {
    const [cellXStr, cellYStr] = key.split(",");
    cells.push({ cellX: Number(cellXStr), cellY: Number(cellYStr), weight });
  }

  return { gridWidth, gridHeight, cellSizeMeters, cells };
}

export interface SnapshotReading {
  apNodeId: string;
  rssi: number;
}

export interface Snapshot {
  timestamp: number;
  readings: SnapshotReading[];
}

/**
 * Groups a device's signal_reading rows (already sorted by timestamp) into
 * snapshots: readings sharing the exact same timestamp are treated as one
 * "moment in time" (the simulator, and a real AP's reporting cycle, emit
 * all of a device's per-AP-node readings for one sampling instant with the
 * same timestamp). Known simplification for the simulated/local-dev
 * pipeline — a real deployment with per-AP-node reporting jitter might
 * need a small time-window tolerance instead of an exact match.
 */
export function groupIntoSnapshots(rows: Array<{ ap_node_id: string; rssi: number; timestamp: number }>): Snapshot[] {
  const snapshots: Snapshot[] = [];
  for (const row of rows) {
    const last = snapshots[snapshots.length - 1];
    if (last && last.timestamp === row.timestamp) {
      last.readings.push({ apNodeId: row.ap_node_id, rssi: row.rssi });
    } else {
      snapshots.push({ timestamp: row.timestamp, readings: [{ apNodeId: row.ap_node_id, rssi: row.rssi }] });
    }
  }
  return snapshots;
}

/**
 * Converts one device's ordered snapshots into weighted position
 * estimates: each snapshot's weight is the time until its successor,
 * capped at SESSION_GAP_MS; a snapshot with no successor (the device's
 * last, or only, snapshot in the given window) receives the cap itself
 * rather than zero — a real, confirmed sighting should never contribute
 * nothing merely because it was the most recent one in the queried data.
 * No-data estimates are excluded; weighted-centroid estimates (1-2 AP
 * nodes) are included as real, if lower-confidence, signal.
 */
export function computeWeightedEstimatesForDevice(
  snapshots: Snapshot[],
  apNodePositions: ApNodePosition[],
  profile: CalibrationProfile
): WeightedPositionEstimate[] {
  const estimates: WeightedPositionEstimate[] = [];

  for (let i = 0; i < snapshots.length; i++) {
    const snapshot = snapshots[i];
    if (!snapshot) continue;
    const estimate = estimateDevicePosition(snapshot.readings, apNodePositions, profile);
    if (estimate.confidence === "no-data") continue;

    const next = snapshots[i + 1];
    const gapToNext = next ? next.timestamp - snapshot.timestamp : SESSION_GAP_MS;
    const weightMs = Math.min(gapToNext, SESSION_GAP_MS);

    estimates.push({ x: estimate.x, y: estimate.y, weightMs });
  }

  return estimates;
}

/**
 * Computes a venue-wide, dwell-time-weighted heatmap from every device's
 * full signal_reading history — extending estimateCurrentPosition's
 * "latest reading only" view into a historical time series per device.
 *
 * Each snapshot's weight is the time until that device's next snapshot,
 * capped at SESSION_GAP_MS (reused from returnVisits.ts) so one stale or
 * final reading can't dominate a cell. A device's last (or only) snapshot
 * — with no subsequent reading to bound it — receives the cap itself
 * (SESSION_GAP_MS), not zero: a real, confirmed sighting should never
 * contribute nothing just because it happened to be the most recent one
 * seen in the queried data.
 *
 * Weighted-centroid estimates (1-2 AP nodes) are included — real, if
 * lower-confidence, signal; a heatmap that discarded them would bias
 * toward areas/times with good AP-node geometry. No-data estimates (0 AP
 * nodes) contribute nothing.
 */
export function computeVenueHeatmap(
  db: DatabaseSync,
  tenantId: string,
  venueId: string,
  config: HeatmapGridConfig = DEFAULT_HEATMAP_CONFIG
): VenueHeatmap {
  const venue = getVenue(db, tenantId, venueId);
  if (!venue) {
    throw new Error(`computeVenueHeatmap: no venue ${venueId} for tenant ${tenantId}`);
  }

  const rows = db
    .prepare(
      `SELECT hashed_device_id, ap_node_id, rssi, timestamp
       FROM ap_events
       WHERE tenant_id = ? AND venue_id = ? AND event_type = 'signal_reading'
       ORDER BY hashed_device_id, timestamp`
    )
    .all(tenantId, venueId) as Array<{
    hashed_device_id: string;
    ap_node_id: string;
    rssi: number;
    timestamp: number;
  }>;

  const apNodePositions = getApNodesForVenue(db, tenantId, venueId).map((n) => ({
    apNodeId: n.apNodeId,
    x: n.x,
    y: n.y,
  }));
  const profile = getCalibrationProfile(db, tenantId, venueId);

  const weightedEstimates: WeightedPositionEstimate[] = [];

  let deviceRows: typeof rows = [];
  let currentDeviceId: string | null = null;

  const flushDevice = () => {
    if (deviceRows.length === 0) return;
    const snapshots = groupIntoSnapshots(deviceRows);
    weightedEstimates.push(...computeWeightedEstimatesForDevice(snapshots, apNodePositions, profile));
  };

  for (const row of rows) {
    if (currentDeviceId !== null && row.hashed_device_id !== currentDeviceId) {
      flushDevice();
      deviceRows = [];
    }
    currentDeviceId = row.hashed_device_id;
    deviceRows.push(row);
  }
  flushDevice();

  return buildHeatmapFromEstimates(weightedEstimates, venue.floorWidth, venue.floorHeight, config.cellSizeMeters);
}

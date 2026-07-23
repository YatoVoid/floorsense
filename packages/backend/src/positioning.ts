import type { DatabaseSync } from "node:sqlite";
import { estimateDevicePosition, type PositionEstimate } from "@floorsense/positioning";
import { getApNodesForVenue } from "./tenancy.ts";
import { getCalibrationProfile } from "./calibration.ts";

/** Estimates a device's current position from its most recent signal_reading per AP node, using the venue's calibration profile. */
export function estimateCurrentPosition(
  db: DatabaseSync,
  tenantId: string,
  venueId: string,
  hashedDeviceId: string
): PositionEstimate {
  // SQLite's bare-column trick: with one MAX() and a GROUP BY, rssi comes from the max-timestamp row.
  const rows = db
    .prepare(
      `SELECT ap_node_id, rssi, MAX(timestamp) AS latest_timestamp
       FROM ap_events
       WHERE tenant_id = ? AND venue_id = ? AND hashed_device_id = ? AND event_type = 'signal_reading'
       GROUP BY ap_node_id`
    )
    .all(tenantId, venueId, hashedDeviceId) as Array<{
    ap_node_id: string;
    rssi: number | null;
    latest_timestamp: number;
  }>;

  const readings = rows
    .filter((r): r is { ap_node_id: string; rssi: number; latest_timestamp: number } => r.rssi !== null)
    .map((r) => ({ apNodeId: r.ap_node_id, rssi: r.rssi }));

  if (readings.length === 0) return { confidence: "no-data" };

  const apNodePositions = getApNodesForVenue(db, tenantId, venueId).map((n) => ({
    apNodeId: n.apNodeId,
    x: n.x,
    y: n.y,
  }));
  const profile = getCalibrationProfile(db, tenantId, venueId);

  return estimateDevicePosition(readings, apNodePositions, profile);
}

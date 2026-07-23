import type { DatabaseSync } from "node:sqlite";
import { estimateDevicePosition, type PositionEstimate } from "@floorsense/positioning";
import { getApNodesForVenue } from "./tenancy.ts";
import { getCalibrationProfile } from "./calibration.ts";

/**
 * Estimates a device's current (x, y) position within a venue from its most
 * recent signal_reading RSSI per AP node, using the venue's fitted (or
 * default) calibration profile. tenant_id/venue_id/hashed_device_id are all
 * filtered in the SQL's own WHERE clause, not narrowed in application code
 * after a broader read — consistent with the rest of the backend's
 * no-cross-tenant-read convention.
 */
export function estimateCurrentPosition(
  db: DatabaseSync,
  tenantId: string,
  venueId: string,
  hashedDeviceId: string
): PositionEstimate {
  // SQLite's documented bare-column behavior: with exactly one MAX()
  // aggregate and a GROUP BY, non-aggregated selected columns (rssi here)
  // come from the row that produced that MAX value — so this returns each
  // AP node's most recent signal_reading, not an arbitrary one.
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

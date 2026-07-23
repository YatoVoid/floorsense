import type { DatabaseSync } from "node:sqlite";
import { isValidApEvent, type ApEvent } from "@floorsense/shared";

export interface StoredApEvent {
  id: number;
  tenantId: string;
  venueId: string;
  apNodeId: string;
  hashedDeviceId: string;
  eventType: ApEvent["type"];
  rssi: number | null;
  timestamp: number;
}

/**
 * Persists a single ApEvent. Validates the event's shape before writing —
 * a malformed event is rejected (returns false), never silently stored.
 */
export function ingestApEvent(db: DatabaseSync, event: unknown): boolean {
  if (!isValidApEvent(event)) return false;

  const rssi = event.type === "signal_reading" ? event.rssi : null;
  db.prepare(
    `INSERT INTO ap_events (tenant_id, venue_id, ap_node_id, hashed_device_id, event_type, rssi, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(event.tenantId, event.venueId, event.apNodeId, event.hashedDeviceId, event.type, rssi, event.timestamp);
  return true;
}

/**
 * Tenant-scoped read of events for a venue — tenantId is required, so a
 * cross-tenant read is not reachable through this function.
 */
export function getEventsForVenue(db: DatabaseSync, tenantId: string, venueId: string): StoredApEvent[] {
  const rows = db
    .prepare(
      "SELECT * FROM ap_events WHERE tenant_id = ? AND venue_id = ? ORDER BY timestamp ASC"
    )
    .all(tenantId, venueId) as Array<{
    id: number;
    tenant_id: string;
    venue_id: string;
    ap_node_id: string;
    hashed_device_id: string;
    event_type: string;
    rssi: number | null;
    timestamp: number;
  }>;
  return rows.map((r) => ({
    id: r.id,
    tenantId: r.tenant_id,
    venueId: r.venue_id,
    apNodeId: r.ap_node_id,
    hashedDeviceId: r.hashed_device_id,
    eventType: r.event_type as ApEvent["type"],
    rssi: r.rssi,
    timestamp: r.timestamp,
  }));
}

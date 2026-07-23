import type { DatabaseSync } from "node:sqlite";
import { isValidApEvent, type ApEvent } from "@floorsense/shared";
import { hasConsent } from "./consent.ts";

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

export type IngestResult =
  | { accepted: true }
  | { accepted: false; reason: "invalid_event" | "no_consent" };

/**
 * Persists a single ApEvent — but only for a device that already has a
 * consent_grants row for this tenant/venue. This is the structural
 * enforcement point for the "no session without consent" invariant: every
 * event type (join/leave/signal_reading) is gated here, not just join, so a
 * device can never be tracked in any form before it has gone through the
 * captive portal's accept step.
 */
export function ingestApEvent(db: DatabaseSync, event: unknown): IngestResult {
  if (!isValidApEvent(event)) return { accepted: false, reason: "invalid_event" };

  if (!hasConsent(db, event.tenantId, event.venueId, event.hashedDeviceId)) {
    return { accepted: false, reason: "no_consent" };
  }

  const rssi = event.type === "signal_reading" ? event.rssi : null;
  db.prepare(
    `INSERT INTO ap_events (tenant_id, venue_id, ap_node_id, hashed_device_id, event_type, rssi, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(event.tenantId, event.venueId, event.apNodeId, event.hashedDeviceId, event.type, rssi, event.timestamp);
  return { accepted: true };
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

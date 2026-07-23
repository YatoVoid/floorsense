import type { HashedDeviceId } from "./hashDeviceId.ts";

interface ApEventBase {
  hashedDeviceId: HashedDeviceId;
  tenantId: string;
  venueId: string;
  apNodeId: string;
  timestamp: number;
}

export interface JoinEvent extends ApEventBase {
  type: "join";
}

export interface LeaveEvent extends ApEventBase {
  type: "leave";
}

export interface SignalReadingEvent extends ApEventBase {
  type: "signal_reading";
  rssi: number;
}

export type ApEvent = JoinEvent | LeaveEvent | SignalReadingEvent;

const AP_EVENT_TYPES = new Set(["join", "leave", "signal_reading"]);

/**
 * Runtime shape check for an ApEvent. Used at package boundaries (adapter
 * output, backend ingest) where a value's shape isn't statically known —
 * e.g. after deserializing from a queue or a network message.
 */
export function isValidApEvent(value: unknown): value is ApEvent {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;

  if (typeof v["type"] !== "string" || !AP_EVENT_TYPES.has(v["type"])) return false;
  if (typeof v["hashedDeviceId"] !== "string" || v["hashedDeviceId"].length === 0) return false;
  if (typeof v["tenantId"] !== "string" || v["tenantId"].length === 0) return false;
  if (typeof v["venueId"] !== "string" || v["venueId"].length === 0) return false;
  if (typeof v["apNodeId"] !== "string" || v["apNodeId"].length === 0) return false;
  if (typeof v["timestamp"] !== "number" || !Number.isFinite(v["timestamp"])) return false;

  if (v["type"] === "signal_reading") {
    if (typeof v["rssi"] !== "number" || !Number.isFinite(v["rssi"])) return false;
  }

  return true;
}

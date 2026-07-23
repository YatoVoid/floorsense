import type { DatabaseSync } from "node:sqlite";
import type { StoredApEvent } from "./ingest.ts";
import { getEventsForVenue } from "./ingest.ts";

export interface DeviceSession {
  hashedDeviceId: string;
  venueId: string;
  joinedAt: number;
  leftAt: number | null;
  dwellTimeMs: number | null;
}

function keyOf(venueId: string, hashedDeviceId: string): string {
  return `${venueId}::${hashedDeviceId}`;
}

/**
 * Reconstructs sessions by pairing each device's join/leave events.
 * Sorts by timestamp first. A dangling leave (no open join) is skipped.
 * An unmatched join (still open, or superseded by a second join) gets
 * leftAt/dwellTimeMs both null instead of a guessed end time.
 */
export function reconstructSessions(events: StoredApEvent[]): DeviceSession[] {
  const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp);
  const openJoins = new Map<string, number>();
  const sessions: DeviceSession[] = [];

  for (const event of sorted) {
    if (event.eventType === "signal_reading") continue;
    const key = keyOf(event.venueId, event.hashedDeviceId);

    if (event.eventType === "join") {
      const existingOpen = openJoins.get(key);
      if (existingOpen !== undefined) {
        sessions.push({
          hashedDeviceId: event.hashedDeviceId,
          venueId: event.venueId,
          joinedAt: existingOpen,
          leftAt: null,
          dwellTimeMs: null,
        });
      }
      openJoins.set(key, event.timestamp);
      continue;
    }

    // event.eventType === "leave"
    const openJoinedAt = openJoins.get(key);
    if (openJoinedAt === undefined) continue; // dangling leave, skip it

    sessions.push({
      hashedDeviceId: event.hashedDeviceId,
      venueId: event.venueId,
      joinedAt: openJoinedAt,
      leftAt: event.timestamp,
      dwellTimeMs: event.timestamp - openJoinedAt,
    });
    openJoins.delete(key);
  }

  for (const [key, joinedAt] of openJoins) {
    const separatorIndex = key.indexOf("::");
    sessions.push({
      hashedDeviceId: key.slice(separatorIndex + 2),
      venueId: key.slice(0, separatorIndex),
      joinedAt,
      leftAt: null,
      dwellTimeMs: null,
    });
  }

  return sessions.sort((a, b) => a.joinedAt - b.joinedAt);
}

/** Tenant-scoped: pulls this venue's events, then reconstructs sessions across all its devices. */
export function getSessionsForVenue(db: DatabaseSync, tenantId: string, venueId: string): DeviceSession[] {
  return reconstructSessions(getEventsForVenue(db, tenantId, venueId));
}

/** Tenant-scoped: same as getSessionsForVenue, narrowed to a single device. */
export function getSessionsForDevice(
  db: DatabaseSync,
  tenantId: string,
  venueId: string,
  hashedDeviceId: string
): DeviceSession[] {
  const events = getEventsForVenue(db, tenantId, venueId).filter((e) => e.hashedDeviceId === hashedDeviceId);
  return reconstructSessions(events);
}

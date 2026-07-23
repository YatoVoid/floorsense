import type { DatabaseSync } from "node:sqlite";
import type { DeviceSession } from "./sessions.ts";
import { getSessionsForVenue } from "./sessions.ts";

/** Gaps shorter than this are treated as one visit (brief signal dropout), not two. Product judgment call, not a scientific constant. */
export const SESSION_GAP_MS = 15 * 60 * 1000;

export interface Visit {
  hashedDeviceId: string;
  venueId: string;
  joinedAt: number;
  leftAt: number | null;
  dwellTimeMs: number | null;
}

function groupByDevice(sessions: DeviceSession[]): Map<string, DeviceSession[]> {
  const map = new Map<string, DeviceSession[]>();
  for (const session of sessions) {
    const arr = map.get(session.hashedDeviceId) ?? [];
    arr.push(session);
    map.set(session.hashedDeviceId, arr);
  }
  for (const arr of map.values()) arr.sort((a, b) => a.joinedAt - b.joinedAt);
  return map;
}

/** Merges sessions with a gap under SESSION_GAP_MS into one visit. A session with leftAt null never merges with what follows (its end time is unknown). */
export function mergeSessionsIntoVisits(sessions: DeviceSession[]): Visit[] {
  const visits: Visit[] = [];

  for (const session of sessions) {
    const last = visits[visits.length - 1];
    if (last && last.leftAt !== null && session.joinedAt - last.leftAt < SESSION_GAP_MS) {
      last.leftAt = session.leftAt;
      last.dwellTimeMs =
        last.dwellTimeMs !== null && session.dwellTimeMs !== null ? last.dwellTimeMs + session.dwellTimeMs : null;
      continue;
    }
    visits.push({
      hashedDeviceId: session.hashedDeviceId,
      venueId: session.venueId,
      joinedAt: session.joinedAt,
      leftAt: session.leftAt,
      dwellTimeMs: session.dwellTimeMs,
    });
  }

  return visits;
}

export interface DeviceReturnStats {
  hashedDeviceId: string;
  visitCount: number;
  averageDwellTimeMs: number | null;
  firstSeenAt: number;
  lastSeenAt: number;
  /** True once a device has 2+ gap-merged visits (came back on a separate occasion). */
  isReturning: boolean;
}

export interface ReturnVisitStats {
  perDevice: DeviceReturnStats[];
  newDeviceCount: number;
  returningDeviceCount: number;
  /** returningDeviceCount / perDevice.length, or 0 if there are no devices at all. */
  returningRatio: number;
  /** Visit-start counts by UTC hour (index 0-23). No venue-timezone data exists yet. */
  hourOfDayDistribution: number[];
}

/** Tenant-scoped: per-device and venue-level return-visit stats from this venue's sessions. */
export function computeReturnVisitStats(db: DatabaseSync, tenantId: string, venueId: string): ReturnVisitStats {
  const sessions = getSessionsForVenue(db, tenantId, venueId);
  const byDevice = groupByDevice(sessions);

  const perDevice: DeviceReturnStats[] = [];
  const hourOfDayDistribution = new Array(24).fill(0) as number[];

  for (const [hashedDeviceId, deviceSessions] of byDevice) {
    const visits = mergeSessionsIntoVisits(deviceSessions);
    if (visits.length === 0) continue;

    for (const visit of visits) {
      const hour = new Date(visit.joinedAt).getUTCHours();
      hourOfDayDistribution[hour] = (hourOfDayDistribution[hour] ?? 0) + 1;
    }

    const knownDwellTimes = visits.map((v) => v.dwellTimeMs).filter((d): d is number => d !== null);
    const averageDwellTimeMs =
      knownDwellTimes.length > 0 ? knownDwellTimes.reduce((a, b) => a + b, 0) / knownDwellTimes.length : null;

    const firstVisit = visits[0];
    const lastVisit = visits[visits.length - 1];
    if (!firstVisit || !lastVisit) continue;

    perDevice.push({
      hashedDeviceId,
      visitCount: visits.length,
      averageDwellTimeMs,
      firstSeenAt: firstVisit.joinedAt,
      lastSeenAt: lastVisit.leftAt ?? lastVisit.joinedAt,
      isReturning: visits.length >= 2,
    });
  }

  const returningDeviceCount = perDevice.filter((d) => d.isReturning).length;
  const newDeviceCount = perDevice.length - returningDeviceCount;
  const returningRatio = perDevice.length > 0 ? returningDeviceCount / perDevice.length : 0;

  return { perDevice, newDeviceCount, returningDeviceCount, returningRatio, hourOfDayDistribution };
}

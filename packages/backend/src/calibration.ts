import type { DatabaseSync } from "node:sqlite";
import type { CalibrationProfile } from "@floorsense/positioning";

export const MIN_CALIBRATION_SAMPLES = 5;

/**
 * Used until a venue has fitted its own profile. Matches ap-adapter-sim's
 * simulator constants — a reasonable central estimate for typical indoor
 * WiFi path loss (exponent commonly cited as 2-4) rather than an arbitrary
 * placeholder — so positioning degrades gracefully for a brand-new venue
 * instead of failing.
 */
export const DEFAULT_CALIBRATION_PROFILE: CalibrationProfile = {
  referenceRssiAt1m: -40,
  pathLossExponent: 2.7,
};

export interface CalibrationSampleInput {
  tenantId: string;
  venueId: string;
  apNodeId: string;
  rssi: number;
  knownX: number;
  knownY: number;
}

/** Records one "owner stood at this marked floor position, this AP node saw this RSSI" sample. */
export function recordCalibrationSample(db: DatabaseSync, input: CalibrationSampleInput): void {
  db.prepare(
    `INSERT INTO calibration_samples (tenant_id, venue_id, ap_node_id, rssi, known_x, known_y, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(input.tenantId, input.venueId, input.apNodeId, input.rssi, input.knownX, input.knownY, Date.now());
}

/**
 * Fits referenceRssiAt1m/pathLossExponent via linear regression of RSSI
 * against log10(distance) across this venue's calibration samples (distance
 * computed from each sample's known floor position to its AP node's actual
 * position). Returns null — and does not upsert anything — when there are
 * fewer than MIN_CALIBRATION_SAMPLES samples, or when the samples don't
 * carry enough distance variance to fit reliably (e.g. all recorded at
 * essentially the same distance from every AP node); callers fall back to
 * getCalibrationProfile's documented default in either case rather than
 * trusting a degenerate fit.
 */
export function fitCalibrationProfile(
  db: DatabaseSync,
  tenantId: string,
  venueId: string
): CalibrationProfile | null {
  const rows = db
    .prepare(
      `SELECT calibration_samples.rssi, calibration_samples.known_x, calibration_samples.known_y,
              ap_nodes.x AS ap_x, ap_nodes.y AS ap_y
       FROM calibration_samples
       JOIN ap_nodes ON ap_nodes.venue_id = calibration_samples.venue_id
                    AND ap_nodes.ap_node_id = calibration_samples.ap_node_id
       WHERE calibration_samples.tenant_id = ? AND calibration_samples.venue_id = ?`
    )
    .all(tenantId, venueId) as Array<{
    rssi: number;
    known_x: number;
    known_y: number;
    ap_x: number;
    ap_y: number;
  }>;

  if (rows.length < MIN_CALIBRATION_SAMPLES) return null;

  const points = rows.map((r) => {
    const dist = Math.max(Math.hypot(r.known_x - r.ap_x, r.known_y - r.ap_y), 0.1);
    return { logDist: Math.log10(dist), rssi: r.rssi };
  });

  const n = points.length;
  const sumX = points.reduce((s, p) => s + p.logDist, 0);
  const sumY = points.reduce((s, p) => s + p.rssi, 0);
  const sumXY = points.reduce((s, p) => s + p.logDist * p.rssi, 0);
  const sumXX = points.reduce((s, p) => s + p.logDist * p.logDist, 0);

  const denominator = n * sumXX - sumX * sumX;
  if (Math.abs(denominator) < 1e-9) return null;

  const slope = (n * sumXY - sumX * sumY) / denominator;
  const intercept = (sumY - slope * sumX) / n;
  const pathLossExponent = -slope / 10;

  if (!Number.isFinite(intercept) || !Number.isFinite(pathLossExponent) || pathLossExponent <= 0) return null;

  const profile: CalibrationProfile = { referenceRssiAt1m: intercept, pathLossExponent };

  db.prepare(
    `INSERT INTO venue_calibration_profiles (tenant_id, venue_id, reference_rssi_at_1m, path_loss_exponent, sample_count, fitted_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (tenant_id, venue_id)
     DO UPDATE SET reference_rssi_at_1m = excluded.reference_rssi_at_1m,
                   path_loss_exponent = excluded.path_loss_exponent,
                   sample_count = excluded.sample_count,
                   fitted_at = excluded.fitted_at`
  ).run(tenantId, venueId, profile.referenceRssiAt1m, profile.pathLossExponent, n, Date.now());

  return profile;
}

/** Tenant-scoped read, following the rest of the backend's no-cross-tenant-read convention. */
export function getCalibrationProfile(db: DatabaseSync, tenantId: string, venueId: string): CalibrationProfile {
  const row = db
    .prepare(
      `SELECT reference_rssi_at_1m, path_loss_exponent FROM venue_calibration_profiles
       WHERE tenant_id = ? AND venue_id = ?`
    )
    .get(tenantId, venueId) as { reference_rssi_at_1m: number; path_loss_exponent: number } | undefined;

  if (!row) return DEFAULT_CALIBRATION_PROFILE;
  return { referenceRssiAt1m: row.reference_rssi_at_1m, pathLossExponent: row.path_loss_exponent };
}

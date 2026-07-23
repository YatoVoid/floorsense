import type { DatabaseSync } from "node:sqlite";
import type { CalibrationProfile } from "@floorsense/positioning";

export const MIN_CALIBRATION_SAMPLES = 5;
/** Below this many of an AP node's own samples, its per-node reference RSSI isn't fitted - falls back to the shared value instead of overfitting on too few points. */
export const MIN_CALIBRATION_SAMPLES_PER_AP_NODE = 3;
/** Residuals beyond this many standard deviations from the shared fit are treated as outliers (a single mis-marked position or stray RF reflection) and dropped before the final fit. */
const OUTLIER_STDDEV_THRESHOLD = 2.5;

/** Used until a venue fits its own profile. Typical indoor WiFi path-loss exponent is 2-4. */
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

interface CalibrationPoint {
  logDist: number;
  rssi: number;
  apNodeId: string;
}

interface LinearFit {
  slope: number;
  intercept: number;
}

/** Ordinary least squares on (logDist, rssi). Null if the fit is degenerate (near-zero distance variance) or non-finite. */
function fitLinear(points: CalibrationPoint[]): LinearFit | null {
  const n = points.length;
  const sumX = points.reduce((s, p) => s + p.logDist, 0);
  const sumY = points.reduce((s, p) => s + p.rssi, 0);
  const sumXY = points.reduce((s, p) => s + p.logDist * p.rssi, 0);
  const sumXX = points.reduce((s, p) => s + p.logDist * p.logDist, 0);

  const denominator = n * sumXX - sumX * sumX;
  if (Math.abs(denominator) < 1e-9) return null;

  const slope = (n * sumXY - sumX * sumY) / denominator;
  const intercept = (sumY - slope * sumX) / n;
  if (!Number.isFinite(slope) || !Number.isFinite(intercept)) return null;
  return { slope, intercept };
}

/** Drops points whose residual against `fit` is beyond OUTLIER_STDDEV_THRESHOLD standard deviations. Returns the input unchanged if there's nothing to reject or too few residuals to judge. */
function rejectOutliers(points: CalibrationPoint[], fit: LinearFit): CalibrationPoint[] {
  const residuals = points.map((p) => p.rssi - (fit.intercept + fit.slope * p.logDist));
  const mean = residuals.reduce((s, r) => s + r, 0) / residuals.length;
  const variance = residuals.reduce((s, r) => s + (r - mean) * (r - mean), 0) / residuals.length;
  const stddev = Math.sqrt(variance);
  if (stddev < 1e-9) return points;

  return points.filter((_, i) => Math.abs((residuals[i] as number) - mean) <= OUTLIER_STDDEV_THRESHOLD * stddev);
}

/**
 * Fits a shared path-loss exponent and reference RSSI across the whole venue,
 * with one robust refit pass to drop outlier samples, plus a per-AP-node
 * reference RSSI for any AP node with enough of its own samples (real
 * hardware has unit-to-unit transmit-power/antenna variance a single shared
 * intercept can't capture). Returns null below MIN_CALIBRATION_SAMPLES or if
 * distance variance is too low to fit reliably.
 */
export function fitCalibrationProfile(
  db: DatabaseSync,
  tenantId: string,
  venueId: string
): CalibrationProfile | null {
  const rows = db
    .prepare(
      `SELECT calibration_samples.rssi, calibration_samples.known_x, calibration_samples.known_y,
              calibration_samples.ap_node_id, ap_nodes.x AS ap_x, ap_nodes.y AS ap_y
       FROM calibration_samples
       JOIN ap_nodes ON ap_nodes.venue_id = calibration_samples.venue_id
                    AND ap_nodes.ap_node_id = calibration_samples.ap_node_id
       WHERE calibration_samples.tenant_id = ? AND calibration_samples.venue_id = ?`
    )
    .all(tenantId, venueId) as Array<{
    rssi: number;
    known_x: number;
    known_y: number;
    ap_node_id: string;
    ap_x: number;
    ap_y: number;
  }>;

  if (rows.length < MIN_CALIBRATION_SAMPLES) return null;

  const points: CalibrationPoint[] = rows.map((r) => {
    const dist = Math.max(Math.hypot(r.known_x - r.ap_x, r.known_y - r.ap_y), 0.1);
    return { logDist: Math.log10(dist), rssi: r.rssi, apNodeId: r.ap_node_id };
  });

  const initialFit = fitLinear(points);
  if (!initialFit) return null;

  const filtered = rejectOutliers(points, initialFit);
  const usePoints = filtered.length >= MIN_CALIBRATION_SAMPLES ? filtered : points;
  const finalFit = usePoints === points ? initialFit : (fitLinear(usePoints) ?? initialFit);

  const pathLossExponent = -finalFit.slope / 10;
  if (!Number.isFinite(pathLossExponent) || pathLossExponent <= 0) return null;

  const perApNodeReferenceRssi: Record<string, number> = {};
  const byApNode = new Map<string, CalibrationPoint[]>();
  for (const point of usePoints) {
    const group = byApNode.get(point.apNodeId) ?? [];
    group.push(point);
    byApNode.set(point.apNodeId, group);
  }
  for (const [apNodeId, group] of byApNode) {
    if (group.length < MIN_CALIBRATION_SAMPLES_PER_AP_NODE) continue;
    const shiftedSum = group.reduce((s, p) => s + (p.rssi - finalFit.slope * p.logDist), 0);
    perApNodeReferenceRssi[apNodeId] = shiftedSum / group.length;
  }

  const profile: CalibrationProfile = {
    referenceRssiAt1m: finalFit.intercept,
    pathLossExponent,
    ...(Object.keys(perApNodeReferenceRssi).length > 0 ? { perApNodeReferenceRssi } : {}),
  };

  const fittedAt = Date.now();
  db.prepare(
    `INSERT INTO venue_calibration_profiles (tenant_id, venue_id, reference_rssi_at_1m, path_loss_exponent, sample_count, fitted_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (tenant_id, venue_id)
     DO UPDATE SET reference_rssi_at_1m = excluded.reference_rssi_at_1m,
                   path_loss_exponent = excluded.path_loss_exponent,
                   sample_count = excluded.sample_count,
                   fitted_at = excluded.fitted_at`
  ).run(tenantId, venueId, profile.referenceRssiAt1m, profile.pathLossExponent, usePoints.length, fittedAt);

  db.prepare(`DELETE FROM venue_calibration_ap_profiles WHERE tenant_id = ? AND venue_id = ?`).run(tenantId, venueId);
  for (const [apNodeId, referenceRssiAt1m] of Object.entries(perApNodeReferenceRssi)) {
    const group = byApNode.get(apNodeId);
    if (!group) continue;
    db.prepare(
      `INSERT INTO venue_calibration_ap_profiles (tenant_id, venue_id, ap_node_id, reference_rssi_at_1m, sample_count, fitted_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(tenantId, venueId, apNodeId, referenceRssiAt1m, group.length, fittedAt);
  }

  return profile;
}

/** Tenant-scoped read. */
export function getCalibrationProfile(db: DatabaseSync, tenantId: string, venueId: string): CalibrationProfile {
  const row = db
    .prepare(
      `SELECT reference_rssi_at_1m, path_loss_exponent FROM venue_calibration_profiles
       WHERE tenant_id = ? AND venue_id = ?`
    )
    .get(tenantId, venueId) as { reference_rssi_at_1m: number; path_loss_exponent: number } | undefined;

  if (!row) return DEFAULT_CALIBRATION_PROFILE;

  const apRows = db
    .prepare(
      `SELECT ap_node_id, reference_rssi_at_1m FROM venue_calibration_ap_profiles
       WHERE tenant_id = ? AND venue_id = ?`
    )
    .all(tenantId, venueId) as Array<{ ap_node_id: string; reference_rssi_at_1m: number }>;

  const perApNodeReferenceRssi: Record<string, number> = {};
  for (const apRow of apRows) {
    perApNodeReferenceRssi[apRow.ap_node_id] = apRow.reference_rssi_at_1m;
  }

  return {
    referenceRssiAt1m: row.reference_rssi_at_1m,
    pathLossExponent: row.path_loss_exponent,
    ...(apRows.length > 0 ? { perApNodeReferenceRssi } : {}),
  };
}

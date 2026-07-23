export interface Point {
  x: number;
  y: number;
}

export interface ApNodePosition {
  apNodeId: string;
  x: number;
  y: number;
}

export interface RssiReading {
  apNodeId: string;
  rssi: number;
}

export interface CalibrationProfile {
  referenceRssiAt1m: number;
  pathLossExponent: number;
  /** Per-AP-node override for referenceRssiAt1m, accounting for real radios' transmit-power/antenna differences. Falls back to referenceRssiAt1m when an AP node isn't present here. */
  perApNodeReferenceRssi?: Record<string, number>;
}

export type PositionEstimate =
  | { confidence: "trilaterated"; x: number; y: number; apNodeIdsUsed: string[] }
  | { confidence: "weighted-centroid"; x: number; y: number; apNodeIdsUsed: string[] }
  | { confidence: "no-data" };

/** Inverts the log-distance path-loss formula to recover distance from RSSI. apNodeId picks a per-AP reference RSSI when the profile has one, else falls back to the shared value. */
export function rssiToDistance(rssi: number, profile: CalibrationProfile, apNodeId?: string): number {
  const referenceRssiAt1m =
    (apNodeId !== undefined ? profile.perApNodeReferenceRssi?.[apNodeId] : undefined) ?? profile.referenceRssiAt1m;
  const exponent = (referenceRssiAt1m - rssi) / (10 * profile.pathLossExponent);
  return Math.pow(10, exponent);
}

interface MatchedReading {
  apNodeId: string;
  x: number;
  y: number;
  distance: number;
}

function matchReadings(
  readings: RssiReading[],
  apNodePositions: ApNodePosition[],
  profile: CalibrationProfile
): MatchedReading[] {
  const byId = new Map(apNodePositions.map((n) => [n.apNodeId, n]));
  const matched: MatchedReading[] = [];
  for (const reading of readings) {
    const node = byId.get(reading.apNodeId);
    if (!node) continue;
    matched.push({
      apNodeId: node.apNodeId,
      x: node.x,
      y: node.y,
      distance: rssiToDistance(reading.rssi, profile, node.apNodeId),
    });
  }
  return matched;
}

/** Closer AP nodes (smaller distance) are weighted more heavily, inverse-square. */
function weightedCentroid(matched: MatchedReading[]): Point {
  let sumW = 0;
  let sumWx = 0;
  let sumWy = 0;
  for (const m of matched) {
    const d = Math.max(m.distance, 0.1);
    const w = 1 / (d * d);
    sumW += w;
    sumWx += w * m.x;
    sumWy += w * m.y;
  }
  return { x: sumWx / sumW, y: sumWy / sumW };
}

const SINGULARITY_EPSILON = 1e-9;
/** Collinearity guard: near 1 means the anchors barely span 2D space. */
const COLLINEARITY_THRESHOLD = 1 - 1e-6;

/** Linearized least-squares multilateration (subtract one anchor's circle equation from the rest, solve via Cramer's rule). Returns null instead of NaN/Infinity for a near-collinear anchor layout. */
function trilaterate(matched: MatchedReading[]): Point | null {
  const ref = matched[0];
  if (!ref) return null;

  let ata00 = 0;
  let ata01 = 0;
  let ata11 = 0;
  let atb0 = 0;
  let atb1 = 0;

  for (let i = 1; i < matched.length; i++) {
    const m = matched[i];
    if (!m) continue;
    const a1 = 2 * (m.x - ref.x);
    const a2 = 2 * (m.y - ref.y);
    const b =
      m.x * m.x -
      ref.x * ref.x +
      (m.y * m.y - ref.y * ref.y) -
      (m.distance * m.distance - ref.distance * ref.distance);

    ata00 += a1 * a1;
    ata01 += a1 * a2;
    ata11 += a2 * a2;
    atb0 += a1 * b;
    atb1 += a2 * b;
  }

  if (ata00 < SINGULARITY_EPSILON || ata11 < SINGULARITY_EPSILON) return null;
  if ((ata01 * ata01) / (ata00 * ata11) > COLLINEARITY_THRESHOLD) return null;

  const det = ata00 * ata11 - ata01 * ata01;
  const x = (atb0 * ata11 - ata01 * atb1) / det;
  const y = (ata00 * atb1 - atb0 * ata01) / det;
  return { x, y };
}

/** Trilaterates with 3+ AP nodes (falls back to weighted centroid if collinear), weighted centroid with 1-2, "no-data" with 0. */
export function estimateDevicePosition(
  readings: RssiReading[],
  apNodePositions: ApNodePosition[],
  profile: CalibrationProfile
): PositionEstimate {
  const matched = matchReadings(readings, apNodePositions, profile);
  if (matched.length === 0) return { confidence: "no-data" };

  const apNodeIdsUsed = matched.map((m) => m.apNodeId);

  if (matched.length >= 3) {
    const solved = trilaterate(matched);
    if (solved) {
      return { confidence: "trilaterated", x: solved.x, y: solved.y, apNodeIdsUsed };
    }
  }

  const centroid = weightedCentroid(matched);
  return { confidence: "weighted-centroid", x: centroid.x, y: centroid.y, apNodeIdsUsed };
}

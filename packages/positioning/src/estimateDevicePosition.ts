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
}

export type PositionEstimate =
  | { confidence: "trilaterated"; x: number; y: number; apNodeIdsUsed: string[] }
  | { confidence: "weighted-centroid"; x: number; y: number; apNodeIdsUsed: string[] }
  | { confidence: "no-data" };

/** Inverts the log-distance path-loss formula to recover distance from RSSI. */
export function rssiToDistance(rssi: number, profile: CalibrationProfile): number {
  const exponent = (profile.referenceRssiAt1m - rssi) / (10 * profile.pathLossExponent);
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
    matched.push({ apNodeId: node.apNodeId, x: node.x, y: node.y, distance: rssiToDistance(reading.rssi, profile) });
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
/** How close to 1 the squared-cosine-of-angle ratio can get before the anchor layout is treated as too collinear to trust. */
const COLLINEARITY_THRESHOLD = 1 - 1e-6;

/**
 * Linear-least-squares multilateration: subtracts a reference anchor's
 * circle equation from every other anchor's to linearize, then solves the
 * resulting 2-unknown normal equations via Cramer's rule.
 *
 * Returns null (rather than NaN/Infinity from a near-singular solve) when
 * the anchor layout is too close to collinear: ata01^2/(ata00*ata11) is the
 * squared cosine of the angle between the two linearized equations'
 * coefficient directions, scale-invariant regardless of the venue's actual
 * coordinate units — as it approaches 1, the anchors don't meaningfully
 * span 2D space and the solve becomes unreliable.
 */
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

/**
 * Estimates a device's (x, y) position from RSSI readings against known
 * AP node positions. Trilaterates when >=3 AP nodes reported (falling back
 * to a weighted centroid if that anchor layout is too collinear to solve
 * reliably); uses a weighted centroid directly for 1-2 AP nodes; returns
 * an explicit "no-data" result for 0 matched readings rather than a
 * fabricated position.
 */
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

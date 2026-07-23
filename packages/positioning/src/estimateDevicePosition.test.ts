import assert from "node:assert";
import { test } from "node:test";
import {
  rssiToDistance,
  estimateDevicePosition,
  type ApNodePosition,
  type CalibrationProfile,
} from "./estimateDevicePosition.ts";

const PROFILE: CalibrationProfile = { referenceRssiAt1m: -40, pathLossExponent: 2.7 };

/** Noiseless inverse of rssiToDistance, for synthetic ground-truth RSSI. */
function rssiAtDistance(distance: number, profile: CalibrationProfile): number {
  return profile.referenceRssiAt1m - 10 * profile.pathLossExponent * Math.log10(Math.max(distance, 0.1));
}

test("rssiToDistance returns 1m at the reference RSSI", () => {
  assert.ok(Math.abs(rssiToDistance(PROFILE.referenceRssiAt1m, PROFILE) - 1) < 1e-9);
});

test("rssiToDistance is monotonic: weaker (more negative) RSSI implies greater distance", () => {
  const near = rssiToDistance(-50, PROFILE);
  const far = rssiToDistance(-80, PROFILE);
  assert.ok(far > near);
});

test("rssiToDistance uses a per-AP-node reference RSSI override when present, ignoring the shared value for that AP", () => {
  const profile: CalibrationProfile = {
    referenceRssiAt1m: -40,
    pathLossExponent: 2.7,
    perApNodeReferenceRssi: { "strong-radio": -30 },
  };

  // At the AP's own reference RSSI, distance must be exactly 1m, using ITS OWN intercept, not the shared -40.
  assert.ok(Math.abs(rssiToDistance(-30, profile, "strong-radio") - 1) < 1e-9);

  // An AP node with no override still uses the shared value.
  assert.ok(Math.abs(rssiToDistance(-40, profile, "no-override-radio") - 1) < 1e-9);

  // No apNodeId at all still uses the shared value (backward-compatible 2-argument call).
  assert.ok(Math.abs(rssiToDistance(-40, profile) - 1) < 1e-9);
});

test("trilateration recovers a known point from 3 noiseless AP-node readings", () => {
  const apNodes: ApNodePosition[] = [
    { apNodeId: "ap-1", x: 0, y: 0 },
    { apNodeId: "ap-2", x: 10, y: 0 },
    { apNodeId: "ap-3", x: 5, y: 10 },
  ];
  const truth = { x: 5, y: 3 };
  const readings = apNodes.map((n) => ({
    apNodeId: n.apNodeId,
    rssi: rssiAtDistance(Math.hypot(truth.x - n.x, truth.y - n.y), PROFILE),
  }));

  const estimate = estimateDevicePosition(readings, apNodes, PROFILE);
  assert.strictEqual(estimate.confidence, "trilaterated");
  assert.ok(estimate.confidence === "trilaterated");
  assert.ok(Math.abs(estimate.x - truth.x) < 0.01, `expected x near ${truth.x}, got ${estimate.x}`);
  assert.ok(Math.abs(estimate.y - truth.y) < 0.01, `expected y near ${truth.y}, got ${estimate.y}`);
  assert.deepStrictEqual(new Set(estimate.apNodeIdsUsed), new Set(["ap-1", "ap-2", "ap-3"]));
});

/** Unweighted reference copy of the pre-weighting trilateration algorithm, used only to prove the weighted version is a real improvement, not a stand-in for it. */
function unweightedTrilaterateForComparison(
  matched: Array<{ x: number; y: number; distance: number }>
): { x: number; y: number } | null {
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
    const b = m.x * m.x - ref.x * ref.x + (m.y * m.y - ref.y * ref.y) - (m.distance * m.distance - ref.distance * ref.distance);
    ata00 += a1 * a1;
    ata01 += a1 * a2;
    ata11 += a2 * a2;
    atb0 += a1 * b;
    atb1 += a2 * b;
  }
  const det = ata00 * ata11 - ata01 * ata01;
  return { x: (atb0 * ata11 - ata01 * atb1) / det, y: (ata00 * atb1 - atb0 * ata01) / det };
}

test("weighted trilateration recovers a known point MORE accurately than the unweighted algorithm when one anchor's reading is noisy", () => {
  const apNodes: ApNodePosition[] = [
    { apNodeId: "ap-1", x: 0, y: 0 },
    { apNodeId: "ap-2", x: 10, y: 0 },
    { apNodeId: "ap-3", x: 5, y: 10 },
  ];
  const truth = { x: 5, y: 3 };
  const trueDistances = apNodes.map((n) => Math.hypot(truth.x - n.x, truth.y - n.y));

  // ap-3's reading is deliberately way off (reported as much farther than it
  // truly is), simulating a noisy/unreliable radio - inverse-square weighting
  // should down-weight it heavily since it looks like the least reliable anchor.
  const noisyDistances = [trueDistances[0]!, trueDistances[1]!, trueDistances[2]! + 15];
  const readings = apNodes.map((n, i) => ({
    apNodeId: n.apNodeId,
    rssi: rssiAtDistance(noisyDistances[i]!, PROFILE),
  }));

  const weightedEstimate = estimateDevicePosition(readings, apNodes, PROFILE);
  assert.strictEqual(weightedEstimate.confidence, "trilaterated");
  assert.ok(weightedEstimate.confidence === "trilaterated");
  const weightedError = Math.hypot(weightedEstimate.x - truth.x, weightedEstimate.y - truth.y);

  const matchedForComparison = apNodes.map((n, i) => ({ x: n.x, y: n.y, distance: noisyDistances[i]! }));
  const unweighted = unweightedTrilaterateForComparison(matchedForComparison);
  assert.ok(unweighted);
  const unweightedError = Math.hypot(unweighted!.x - truth.x, unweighted!.y - truth.y);

  assert.ok(
    weightedError < unweightedError,
    `expected weighted error (${weightedError}) to be smaller than unweighted error (${unweightedError})`
  );
});

test("2 AP-node readings fall back to a weighted centroid, reachable and in-bounds", () => {
  const apNodes: ApNodePosition[] = [
    { apNodeId: "ap-1", x: 0, y: 0 },
    { apNodeId: "ap-2", x: 10, y: 0 },
  ];
  const truth = { x: 3, y: 0 };
  const readings = apNodes.map((n) => ({
    apNodeId: n.apNodeId,
    rssi: rssiAtDistance(Math.hypot(truth.x - n.x, truth.y - n.y), PROFILE),
  }));

  const estimate = estimateDevicePosition(readings, apNodes, PROFILE);
  assert.strictEqual(estimate.confidence, "weighted-centroid");
  assert.ok(estimate.confidence === "weighted-centroid");
  assert.ok(estimate.x >= 0 && estimate.x <= 10, "estimate must fall within the AP nodes' span");
  assert.ok(estimate.x < 5, "the device is closer to ap-1, so the weighted centroid should lean toward it");
});

test("a single AP-node reading falls back to a weighted centroid equal to that AP node's position", () => {
  const apNodes: ApNodePosition[] = [{ apNodeId: "ap-1", x: 7, y: 4 }];
  const readings = [{ apNodeId: "ap-1", rssi: rssiAtDistance(2, PROFILE) }];

  const estimate = estimateDevicePosition(readings, apNodes, PROFILE);
  assert.strictEqual(estimate.confidence, "weighted-centroid");
  assert.ok(estimate.confidence === "weighted-centroid");
  assert.ok(Math.abs(estimate.x - 7) < 1e-9);
  assert.ok(Math.abs(estimate.y - 4) < 1e-9);
});

test("zero matched readings returns an explicit no-data result, not a fabricated position", () => {
  const apNodes: ApNodePosition[] = [{ apNodeId: "ap-1", x: 0, y: 0 }];
  const estimate = estimateDevicePosition([{ apNodeId: "ap-unknown", rssi: -60 }], apNodes, PROFILE);
  assert.strictEqual(estimate.confidence, "no-data");
});

test("an exactly-collinear 3-AP-node layout falls back to weighted-centroid instead of NaN/Infinity", () => {
  // All three AP nodes on the x-axis makes the normal equations singular.
  const apNodes: ApNodePosition[] = [
    { apNodeId: "ap-1", x: 0, y: 0 },
    { apNodeId: "ap-2", x: 5, y: 0 },
    { apNodeId: "ap-3", x: 10, y: 0 },
  ];
  const truth = { x: 5, y: 3 };
  const readings = apNodes.map((n) => ({
    apNodeId: n.apNodeId,
    rssi: rssiAtDistance(Math.hypot(truth.x - n.x, truth.y - n.y), PROFILE),
  }));

  const estimate = estimateDevicePosition(readings, apNodes, PROFILE);
  assert.strictEqual(estimate.confidence, "weighted-centroid");
  assert.ok(estimate.confidence === "weighted-centroid");
  assert.ok(Number.isFinite(estimate.x) && Number.isFinite(estimate.y));
});

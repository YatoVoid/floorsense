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

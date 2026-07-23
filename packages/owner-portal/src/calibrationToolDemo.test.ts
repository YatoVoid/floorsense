import assert from "node:assert";
import { test } from "node:test";
import { runCalibrationToolDemo } from "./calibrationToolDemo.ts";

test("calibration samples built via buildCalibrationSamplePayload and submitted over real HTTP produce a correctly fitted profile", async () => {
  const result = await runCalibrationToolDemo();
  assert.strictEqual(result.apNodeCount, 1);
  assert.strictEqual(result.samplesSubmitted, 5);
  assert.ok(Math.abs(result.fittedReferenceRssiAt1m - -40) < 1e-6);
  assert.ok(Math.abs(result.fittedPathLossExponent - 2.7) < 1e-6);
});

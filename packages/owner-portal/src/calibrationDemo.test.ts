import assert from "node:assert";
import { test } from "node:test";
import { runCalibrationDemo } from "./calibrationDemo.ts";

test("calibration samples submitted over real HTTP produce a correctly fitted profile", async () => {
  const result = await runCalibrationDemo();
  assert.strictEqual(result.samplesSubmitted, 5);
  assert.ok(Math.abs(result.fittedReferenceRssiAt1m - -40) < 1e-6);
  assert.ok(Math.abs(result.fittedPathLossExponent - 2.7) < 1e-6);
});

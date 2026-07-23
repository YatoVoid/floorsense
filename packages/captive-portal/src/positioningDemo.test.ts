import assert from "node:assert";
import { test } from "node:test";
import { runPositioningDemo } from "./positioningDemo.ts";

test("the simulated ground-truth round trip recovers a position close to the simulator's actual position", async () => {
  const result = await runPositioningDemo();
  assert.strictEqual(result.estimate.confidence, "trilaterated");
  assert.ok(
    result.distanceError < 0.2,
    `expected a near-exact recovery (noiseless simulation), got distance error ${result.distanceError}`
  );
});

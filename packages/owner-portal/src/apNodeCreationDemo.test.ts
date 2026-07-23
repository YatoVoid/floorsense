import assert from "node:assert";
import { test } from "node:test";
import { runApNodeCreationDemo } from "./apNodeCreationDemo.ts";

test("a brand-new venue starts with zero AP nodes, and adding one immediately unblocks calibration", async () => {
  const result = await runApNodeCreationDemo();

  assert.strictEqual(result.apNodesBeforeCreation, 0, "confirms the originally reported empty state");
  assert.strictEqual(result.apNodeCreateStatus, 201);
  assert.strictEqual(result.apNodesAfterCreation, 1);
  assert.strictEqual(result.calibrationSamplesSubmitted, 5);
  assert.strictEqual(result.fitSucceeded, true);
});

import assert from "node:assert";
import { test } from "node:test";
import { runSessionsDemo } from "./sessionsDemo.ts";

test("reconstructed session count matches the independently-counted join/leave cycle count, and the device is classified as returning", async () => {
  const result = await runSessionsDemo();

  assert.strictEqual(result.groundTruthJoinCount, 2, "expected exactly 2 joins across both simulated visits");
  assert.strictEqual(result.groundTruthLeaveCount, 2, "expected exactly 2 leaves across both simulated visits");
  assert.strictEqual(
    result.reconstructedSessionCount,
    Math.min(result.groundTruthJoinCount, result.groundTruthLeaveCount),
    "reconstructSessions must produce one session per join/leave pair"
  );
  assert.strictEqual(result.visitCount, 2, "the deliberate SESSION_GAP_MS-exceeding gap must not merge the two visits");
  assert.strictEqual(result.isReturning, true);
});

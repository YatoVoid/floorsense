import assert from "node:assert";
import { test } from "node:test";
import { runHardwareIngestDemo } from "./hardwareIngestDemo.ts";

test("real ESP32-shaped HTTP calls (no owner session, token-authenticated) reach the owner's dashboard data", async () => {
  const result = await runHardwareIngestDemo();

  assert.ok(result.hardwareTokenLength >= 32, "the token read back over the API must be a real, long secret");
  assert.strictEqual(result.joinStatus, 201);
  assert.strictEqual(result.signalReadingStatus, 201);
  assert.strictEqual(result.leaveStatus, 201);
  assert.strictEqual(result.newDeviceCountAfterEvents, 1);
});

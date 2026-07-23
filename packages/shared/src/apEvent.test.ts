import assert from "node:assert";
import { test } from "node:test";
import { isValidApEvent } from "./apEvent.ts";
import { hashDeviceId } from "./hashDeviceId.ts";

const hashedId = hashDeviceId("aa:bb:cc:dd:ee:ff", "salt-a");

test("accepts a valid join event", () => {
  assert.strictEqual(
    isValidApEvent({
      type: "join",
      hashedDeviceId: hashedId,
      tenantId: "tenant-1",
      venueId: "venue-1",
      apNodeId: "ap-1",
      timestamp: Date.now(),
    }),
    true
  );
});

test("accepts a valid leave event", () => {
  assert.strictEqual(
    isValidApEvent({
      type: "leave",
      hashedDeviceId: hashedId,
      tenantId: "tenant-1",
      venueId: "venue-1",
      apNodeId: "ap-1",
      timestamp: Date.now(),
    }),
    true
  );
});

test("accepts a valid signal_reading event with rssi", () => {
  assert.strictEqual(
    isValidApEvent({
      type: "signal_reading",
      hashedDeviceId: hashedId,
      tenantId: "tenant-1",
      venueId: "venue-1",
      apNodeId: "ap-1",
      timestamp: Date.now(),
      rssi: -55,
    }),
    true
  );
});

test("rejects a signal_reading event missing rssi", () => {
  assert.strictEqual(
    isValidApEvent({
      type: "signal_reading",
      hashedDeviceId: hashedId,
      tenantId: "tenant-1",
      venueId: "venue-1",
      apNodeId: "ap-1",
      timestamp: Date.now(),
    }),
    false
  );
});

test("rejects an unknown event type", () => {
  assert.strictEqual(
    isValidApEvent({
      type: "probe_request",
      hashedDeviceId: hashedId,
      tenantId: "tenant-1",
      venueId: "venue-1",
      apNodeId: "ap-1",
      timestamp: Date.now(),
    }),
    false
  );
});

test("rejects missing required fields", () => {
  assert.strictEqual(isValidApEvent({ type: "join" }), false);
});

test("rejects non-object input", () => {
  assert.strictEqual(isValidApEvent(null), false);
  assert.strictEqual(isValidApEvent("join"), false);
  assert.strictEqual(isValidApEvent(42), false);
  assert.strictEqual(isValidApEvent(undefined), false);
});

test("rejects a non-finite timestamp", () => {
  assert.strictEqual(
    isValidApEvent({
      type: "join",
      hashedDeviceId: hashedId,
      tenantId: "tenant-1",
      venueId: "venue-1",
      apNodeId: "ap-1",
      timestamp: Number.NaN,
    }),
    false
  );
});

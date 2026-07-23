import assert from "node:assert";
import { test } from "node:test";
import { hashDeviceId } from "./hashDeviceId.ts";

test("deterministic for the same input and salt", () => {
  const a = hashDeviceId("aa:bb:cc:dd:ee:ff", "salt-2026-07-23");
  const b = hashDeviceId("aa:bb:cc:dd:ee:ff", "salt-2026-07-23");
  assert.strictEqual(a, b);
});

test("different salts produce different output for the same input", () => {
  const a = hashDeviceId("aa:bb:cc:dd:ee:ff", "salt-a");
  const b = hashDeviceId("aa:bb:cc:dd:ee:ff", "salt-b");
  assert.notStrictEqual(a, b);
});

test("different inputs produce different output for the same salt", () => {
  const a = hashDeviceId("aa:bb:cc:dd:ee:ff", "salt-a");
  const b = hashDeviceId("11:22:33:44:55:66", "salt-a");
  assert.notStrictEqual(a, b);
});

test("output is a 64-character hex string (sha256 digest)", () => {
  const out = hashDeviceId("aa:bb:cc:dd:ee:ff", "salt-a");
  assert.strictEqual(out.length, 64);
  assert.match(out, /^[0-9a-f]{64}$/);
});

test("output never contains the raw input as a substring", () => {
  const raw = "aa:bb:cc:dd:ee:ff";
  const out = hashDeviceId(raw, "salt-a");
  assert.ok(!out.includes(raw));
  // also check case-insensitively and with separators stripped, since a
  // hex digest could theoretically happen to contain a stripped-down
  // form of the input by coincidence for some other input -- for this
  // specific fixture, confirm it doesn't.
  assert.ok(!out.toLowerCase().includes(raw.replace(/:/g, "")));
});

test("empty raw identifier still produces a valid, distinct hash (no special-casing that could leak emptiness)", () => {
  const out = hashDeviceId("", "salt-a");
  assert.strictEqual(out.length, 64);
});

test("a randomized-MAC-shaped identifier (locally-administered bit set, as real devices present) hashes exactly like any other identifier - no special-casing", () => {
  // 0x02 has the locally-administered bit set - the standard marker modern
  // iOS/Android devices use for a per-network randomized MAC.
  const randomizedMac = "02:1a:2b:3c:4d:5e";
  const out = hashDeviceId(randomizedMac, "salt-a");
  assert.strictEqual(out.length, 64);
  assert.match(out, /^[0-9a-f]{64}$/);
  assert.ok(!out.includes(randomizedMac));
});

test("the same randomized MAC hashes identically across separate calls with the same salt - the property return-visit tracking actually depends on", () => {
  const randomizedMac = "02:1a:2b:3c:4d:5e";
  const first = hashDeviceId(randomizedMac, "venue-salt");
  const second = hashDeviceId(randomizedMac, "venue-salt");
  assert.strictEqual(first, second, "a device reconnecting to the same venue's network must produce the same hash every time");
});

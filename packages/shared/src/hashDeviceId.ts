import { createHash } from "node:crypto";

/**
 * A device identifier that has already been salted and hashed. This is a
 * branded type, not a plain string, so the type system rejects a raw
 * identifier anywhere a hashed one is expected. `hashDeviceId` below is the
 * ONLY function permitted to produce a value of this type.
 */
export type HashedDeviceId = string & { readonly __brand: "HashedDeviceId" };

/**
 * The single, non-bypassable entry point for turning a raw device
 * identifier (e.g. a MAC address) into a HashedDeviceId. Nothing else in
 * this codebase may accept a raw identifier as input — every adapter,
 * real or simulated, must call this before an identifier reaches an
 * APEvent, a log line, or storage.
 */
export function hashDeviceId(rawIdentifier: string, salt: string): HashedDeviceId {
  const digest = createHash("sha256").update(salt).update(rawIdentifier).digest("hex");
  return digest as HashedDeviceId;
}

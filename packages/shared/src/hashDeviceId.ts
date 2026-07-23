import { createHash } from "node:crypto";

/** Branded type so a raw identifier can never type-check as an already-hashed one. */
export type HashedDeviceId = string & { readonly __brand: "HashedDeviceId" };

/** Only place a raw MAC-like identifier is allowed to touch this codebase. */
export function hashDeviceId(rawIdentifier: string, salt: string): HashedDeviceId {
  const digest = createHash("sha256").update(salt).update(rawIdentifier).digest("hex");
  return digest as HashedDeviceId;
}

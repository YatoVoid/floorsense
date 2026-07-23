import type { DatabaseSync } from "node:sqlite";
import { randomUUID, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { Owner } from "./tenancy.ts";

const SCRYPT_KEYLEN = 64;

/** Injectable so tests can count invocations without touching the real node:crypto module. */
export type ScryptFn = (password: string, salt: string, keylen: number) => Buffer;
const defaultScrypt: ScryptFn = (password, salt, keylen) => scryptSync(password, salt, keylen);

// Fixed dummy salt/hash used when no owner matches, so verifyOwnerCredentials
// performs exactly the same shape of work (one scrypt call) whether the
// owner exists or not — an unknown name must not be observably cheaper than
// a known name with the wrong password.
const DUMMY_SALT = "0".repeat(32);
const DUMMY_HASH_HEX = scryptSync("no-such-owner", DUMMY_SALT, SCRYPT_KEYLEN).toString("hex");

/** Creates an owner with a real, salted, hashed password — never stores or returns the plaintext. */
export function createOwnerWithPassword(db: DatabaseSync, name: string, password: string): Owner {
  const id = randomUUID();
  const createdAt = Date.now();
  const salt = randomBytes(16).toString("hex");
  const hash = defaultScrypt(password, salt, SCRYPT_KEYLEN).toString("hex");

  db.prepare(
    "INSERT INTO owners (id, name, created_at, password_hash, password_salt) VALUES (?, ?, ?, ?, ?)"
  ).run(id, name, createdAt, hash, salt);

  return { id, name, createdAt };
}

/**
 * Returns the matching ownerId, or null if the name is unknown or the
 * password is wrong. Always performs exactly one hash computation — even
 * when no owner with this name exists, using a fixed dummy salt/hash — so
 * "unknown owner" and "wrong password" are indistinguishable by call shape,
 * not just by response content. `scrypt` is injectable so tests can wrap it
 * with a counting spy to verify this directly.
 */
export function verifyOwnerCredentials(
  db: DatabaseSync,
  name: string,
  password: string,
  scrypt: ScryptFn = defaultScrypt
): string | null {
  const row = db
    .prepare("SELECT id, password_hash, password_salt FROM owners WHERE name = ?")
    .get(name) as { id: string; password_hash: string | null; password_salt: string | null } | undefined;

  const salt = row?.password_salt ?? DUMMY_SALT;
  const expectedHex = row?.password_hash ?? DUMMY_HASH_HEX;

  const actualHash = scrypt(password, salt, SCRYPT_KEYLEN);
  const expectedHash = Buffer.from(expectedHex, "hex");

  const matches = actualHash.length === expectedHash.length && timingSafeEqual(actualHash, expectedHash);

  if (!row || !matches) return null;
  return row.id;
}

/** Creates a session token for an owner. `now`/`ttlMs` are explicit parameters (not internal Date.now()) so expiry is testable without a real sleep. */
export function createSession(db: DatabaseSync, ownerId: string, now: number, ttlMs: number): string {
  const token = randomUUID();
  db.prepare("INSERT INTO owner_sessions (token, owner_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(
    token,
    ownerId,
    now,
    now + ttlMs
  );
  return token;
}

/** Returns the ownerId for a valid, unexpired session token, or null for a missing/expired/unknown token. `now` is explicit so expiry is testable deterministically. */
export function getOwnerIdForSessionToken(db: DatabaseSync, token: string, now: number): string | null {
  const row = db.prepare("SELECT owner_id, expires_at FROM owner_sessions WHERE token = ?").get(token) as
    | { owner_id: string; expires_at: number }
    | undefined;

  if (!row) return null;
  if (row.expires_at <= now) return null;
  return row.owner_id;
}

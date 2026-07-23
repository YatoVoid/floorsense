import type { DatabaseSync } from "node:sqlite";
import { randomUUID, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { Owner } from "./tenancy.ts";

const SCRYPT_KEYLEN = 64;

/** Injectable so tests can count invocations without mocking node:crypto. */
export type ScryptFn = (password: string, salt: string, keylen: number) => Buffer;
const defaultScrypt: ScryptFn = (password, salt, keylen) => scryptSync(password, salt, keylen);

// Dummy salt/hash for unknown owners, so lookups always cost one scrypt call.
const DUMMY_SALT = "0".repeat(32);
const DUMMY_HASH_HEX = scryptSync("no-such-owner", DUMMY_SALT, SCRYPT_KEYLEN).toString("hex");

/** Stores only a salted hash, never the plaintext password. */
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

/** Always does one hash computation, even for an unknown owner, so lookup timing doesn't leak whether the name exists. */
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

/** `now`/`ttlMs` are passed in explicitly so expiry is testable without a real sleep. */
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

/** Returns the ownerId for a valid, unexpired token, or null if missing/expired/unknown. */
export function getOwnerIdForSessionToken(db: DatabaseSync, token: string, now: number): string | null {
  const row = db.prepare("SELECT owner_id, expires_at FROM owner_sessions WHERE token = ?").get(token) as
    | { owner_id: string; expires_at: number }
    | undefined;

  if (!row) return null;
  if (row.expires_at <= now) return null;
  return row.owner_id;
}

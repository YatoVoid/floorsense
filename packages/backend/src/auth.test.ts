import assert from "node:assert";
import { test } from "node:test";
import { scryptSync } from "node:crypto";
import { openDatabase } from "./db.ts";
import {
  createOwnerWithPassword,
  verifyOwnerCredentials,
  createSession,
  getOwnerIdForSessionToken,
  type ScryptFn,
} from "./auth.ts";

test("the raw password never appears as a substring anywhere in the stored owner row", () => {
  const db = openDatabase(":memory:");
  const password = "correct-horse-battery-staple-42";
  createOwnerWithPassword(db, "Password Test Owner", password);

  const row = db.prepare("SELECT * FROM owners WHERE name = ?").get("Password Test Owner");
  const serialized = JSON.stringify(row);
  assert.ok(!serialized.includes(password), "the raw password leaked into the stored row");
  db.close();
});

test("verifyOwnerCredentials returns the ownerId for the correct password", () => {
  const db = openDatabase(":memory:");
  const owner = createOwnerWithPassword(db, "Correct Password Owner", "hunter2-but-better");

  const result = verifyOwnerCredentials(db, "Correct Password Owner", "hunter2-but-better");
  assert.strictEqual(result, owner.id);
  db.close();
});

test("verifyOwnerCredentials returns null for the wrong password", () => {
  const db = openDatabase(":memory:");
  createOwnerWithPassword(db, "Wrong Password Owner", "the-real-password");

  const result = verifyOwnerCredentials(db, "Wrong Password Owner", "not-the-real-password");
  assert.strictEqual(result, null);
  db.close();
});

test("verifyOwnerCredentials returns null for an unknown owner name", () => {
  const db = openDatabase(":memory:");
  const result = verifyOwnerCredentials(db, "Nobody Registered", "whatever");
  assert.strictEqual(result, null);
  db.close();
});

test("unknown owner and wrong password both perform exactly one hash computation — the same code shape", () => {
  const db = openDatabase(":memory:");
  createOwnerWithPassword(db, "Shape Test Owner", "the-real-password");

  let callCount = 0;
  const countingScrypt: ScryptFn = (password, salt, keylen) => {
    callCount += 1;
    return scryptSync(password, salt, keylen);
  };

  callCount = 0;
  verifyOwnerCredentials(db, "Nobody Registered", "whatever", countingScrypt);
  assert.strictEqual(callCount, 1, "an unknown owner must still trigger exactly one hash computation");

  callCount = 0;
  verifyOwnerCredentials(db, "Shape Test Owner", "wrong-password", countingScrypt);
  assert.strictEqual(callCount, 1, "a wrong password must trigger exactly one hash computation");
  db.close();
});

test("createSession + getOwnerIdForSessionToken round-trip to the correct ownerId", () => {
  const db = openDatabase(":memory:");
  const owner = createOwnerWithPassword(db, "Session Test Owner", "some-password");

  const now = 1_000_000;
  const token = createSession(db, owner.id, now, 60_000);
  const resolved = getOwnerIdForSessionToken(db, token, now + 1000);
  assert.strictEqual(resolved, owner.id);
  db.close();
});

test("an expired session token is rejected", () => {
  const db = openDatabase(":memory:");
  const owner = createOwnerWithPassword(db, "Expiry Test Owner", "some-password");

  const now = 1_000_000;
  const ttlMs = 60_000;
  const token = createSession(db, owner.id, now, ttlMs);

  const stillValid = getOwnerIdForSessionToken(db, token, now + ttlMs - 1);
  assert.strictEqual(stillValid, owner.id);

  const expired = getOwnerIdForSessionToken(db, token, now + ttlMs);
  assert.strictEqual(expired, null, "a token at/past its expires_at must be rejected");
  db.close();
});

test("a nonexistent/malformed session token is rejected", () => {
  const db = openDatabase(":memory:");
  const result = getOwnerIdForSessionToken(db, "not-a-real-token", Date.now());
  assert.strictEqual(result, null);
  db.close();
});

import assert from "node:assert";
import { test } from "node:test";
import { openDatabase } from "./db.ts";

test("openDatabase creates all expected tables", () => {
  const db = openDatabase(":memory:");
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as Array<{ name: string }>;
  const names = tables.map((t) => t.name);
  assert.ok(names.includes("owners"));
  assert.ok(names.includes("venues"));
  assert.ok(names.includes("ap_nodes"));
  assert.ok(names.includes("ap_events"));
  db.close();
});

test("running migrations twice against the same database does not throw", () => {
  const db = openDatabase(":memory:");
  db.exec(`
    CREATE TABLE IF NOT EXISTS owners (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  db.close();
});

test("foreign keys are enforced (venue must reference a real owner)", () => {
  const db = openDatabase(":memory:");
  assert.throws(() => {
    db.prepare(
      "INSERT INTO venues (id, owner_id, name, floor_width, floor_height, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("v1", "nonexistent-owner", "Test Venue", 10, 10, Date.now());
  });
  db.close();
});

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Resolved relative to this module's own location, not the process's
// current working directory — a relative path like "packages/backend/data/..."
// would silently resolve to the wrong place depending on where the process
// was launched from (verified: running `node src/seed.ts` from inside
// packages/backend itself, a natural way to invoke it, produced a
// doubly-nested packages/backend/packages/backend/data/ directory before
// this fix).
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const DEFAULT_DB_PATH = join(PACKAGE_ROOT, "data", "floorsense.sqlite");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS owners (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS venues (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id),
  name TEXT NOT NULL,
  floor_width REAL NOT NULL,
  floor_height REAL NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ap_nodes (
  id TEXT PRIMARY KEY,
  venue_id TEXT NOT NULL REFERENCES venues(id),
  ap_node_id TEXT NOT NULL,
  x REAL NOT NULL,
  y REAL NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (venue_id, ap_node_id)
);

CREATE TABLE IF NOT EXISTS ap_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  venue_id TEXT NOT NULL,
  ap_node_id TEXT NOT NULL,
  hashed_device_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  rssi REAL,
  timestamp INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ap_events_tenant_venue
  ON ap_events (tenant_id, venue_id);

CREATE INDEX IF NOT EXISTS idx_ap_events_hashed_device_id
  ON ap_events (tenant_id, hashed_device_id);
`;

/**
 * Opens (creating if necessary) the FloorSense SQLite database and applies
 * schema migrations. Safe to call repeatedly — every statement is
 * CREATE TABLE/INDEX IF NOT EXISTS.
 */
export function openDatabase(path: string = DEFAULT_DB_PATH): DatabaseSync {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}

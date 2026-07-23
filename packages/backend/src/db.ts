import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Resolved from this module's own location so the path is correct
// regardless of the process's working directory.
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const DEFAULT_DB_PATH = join(PACKAGE_ROOT, "data", "floorsense.sqlite");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS owners (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  password_hash TEXT,
  password_salt TEXT,
  tier TEXT NOT NULL DEFAULT 'basic'
);

CREATE TABLE IF NOT EXISTS owner_sessions (
  token TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
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

CREATE TABLE IF NOT EXISTS consent_grants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  venue_id TEXT NOT NULL,
  hashed_device_id TEXT NOT NULL,
  accepted_at INTEGER NOT NULL,
  terms_version TEXT NOT NULL,
  UNIQUE (tenant_id, venue_id, hashed_device_id)
);

CREATE TABLE IF NOT EXISTS calibration_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  venue_id TEXT NOT NULL,
  ap_node_id TEXT NOT NULL,
  rssi REAL NOT NULL,
  known_x REAL NOT NULL,
  known_y REAL NOT NULL,
  recorded_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_calibration_samples_tenant_venue
  ON calibration_samples (tenant_id, venue_id);

CREATE TABLE IF NOT EXISTS venue_calibration_profiles (
  tenant_id TEXT NOT NULL,
  venue_id TEXT NOT NULL,
  reference_rssi_at_1m REAL NOT NULL,
  path_loss_exponent REAL NOT NULL,
  sample_count INTEGER NOT NULL,
  fitted_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, venue_id)
);

CREATE TABLE IF NOT EXISTS billing_transactions (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id),
  tier TEXT NOT NULL,
  kind TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL,
  charged_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_billing_transactions_owner
  ON billing_transactions (owner_id, charged_at);
`;

/** Safe to call repeatedly, every statement is CREATE IF NOT EXISTS. */
export function openDatabase(path: string = DEFAULT_DB_PATH): DatabaseSync {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}

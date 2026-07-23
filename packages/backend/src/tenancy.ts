import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

export interface Owner {
  id: string;
  name: string;
  createdAt: number;
}

export interface Venue {
  id: string;
  ownerId: string;
  name: string;
  floorWidth: number;
  floorHeight: number;
  createdAt: number;
}

export interface ApNodeRecord {
  id: string;
  venueId: string;
  apNodeId: string;
  x: number;
  y: number;
  createdAt: number;
}

export function createOwner(db: DatabaseSync, name: string): Owner {
  const id = randomUUID();
  const createdAt = Date.now();
  db.prepare("INSERT INTO owners (id, name, created_at) VALUES (?, ?, ?)").run(id, name, createdAt);
  return { id, name, createdAt };
}

export function createVenue(
  db: DatabaseSync,
  ownerId: string,
  input: { name: string; floorWidth: number; floorHeight: number }
): Venue {
  const id = randomUUID();
  const createdAt = Date.now();
  db.prepare(
    "INSERT INTO venues (id, owner_id, name, floor_width, floor_height, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(id, ownerId, input.name, input.floorWidth, input.floorHeight, createdAt);
  return { id, ownerId, name: input.name, floorWidth: input.floorWidth, floorHeight: input.floorHeight, createdAt };
}

export function createApNode(
  db: DatabaseSync,
  venueId: string,
  input: { apNodeId: string; x: number; y: number }
): ApNodeRecord {
  const id = randomUUID();
  const createdAt = Date.now();
  db.prepare(
    "INSERT INTO ap_nodes (id, venue_id, ap_node_id, x, y, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(id, venueId, input.apNodeId, input.x, input.y, createdAt);
  return { id, venueId, apNodeId: input.apNodeId, x: input.x, y: input.y, createdAt };
}

// Every read below requires tenantId in the WHERE clause. No "get all" helper exists that skips it.

export function getVenuesForOwner(db: DatabaseSync, tenantId: string): Venue[] {
  const rows = db.prepare("SELECT * FROM venues WHERE owner_id = ?").all(tenantId) as Array<{
    id: string;
    owner_id: string;
    name: string;
    floor_width: number;
    floor_height: number;
    created_at: number;
  }>;
  return rows.map((r) => ({
    id: r.id,
    ownerId: r.owner_id,
    name: r.name,
    floorWidth: r.floor_width,
    floorHeight: r.floor_height,
    createdAt: r.created_at,
  }));
}

/** Null for a nonexistent venue or one owned by someone else. */
export function getVenue(db: DatabaseSync, tenantId: string, venueId: string): Venue | null {
  const row = db.prepare("SELECT * FROM venues WHERE id = ? AND owner_id = ?").get(venueId, tenantId) as
    | {
        id: string;
        owner_id: string;
        name: string;
        floor_width: number;
        floor_height: number;
        created_at: number;
      }
    | undefined;

  if (!row) return null;
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    floorWidth: row.floor_width,
    floorHeight: row.floor_height,
    createdAt: row.created_at,
  };
}

export function getApNodesForVenue(db: DatabaseSync, tenantId: string, venueId: string): ApNodeRecord[] {
  const rows = db
    .prepare(
      `SELECT ap_nodes.* FROM ap_nodes
       JOIN venues ON venues.id = ap_nodes.venue_id
       WHERE venues.owner_id = ? AND ap_nodes.venue_id = ?`
    )
    .all(tenantId, venueId) as Array<{
    id: string;
    venue_id: string;
    ap_node_id: string;
    x: number;
    y: number;
    created_at: number;
  }>;
  return rows.map((r) => ({
    id: r.id,
    venueId: r.venue_id,
    apNodeId: r.ap_node_id,
    x: r.x,
    y: r.y,
    createdAt: r.created_at,
  }));
}

/** Real DB check, never trust a client's claim of owning a venueId. */
export function venueBelongsToOwner(db: DatabaseSync, tenantId: string, venueId: string): boolean {
  const row = db.prepare("SELECT 1 FROM venues WHERE id = ? AND owner_id = ?").get(venueId, tenantId);
  return row !== undefined;
}

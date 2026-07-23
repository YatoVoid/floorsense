import type { DatabaseSync } from "node:sqlite";
import { createOwner, createVenue, createApNode, getVenuesForOwner } from "./tenancy.ts";

const DEMO_OWNERS = [
  {
    ownerName: "Demo Cafe Owner",
    venueName: "Demo Cafe — Main Floor",
    floorWidth: 20,
    floorHeight: 15,
    apNodes: [
      { apNodeId: "ap-1", x: 1, y: 1 },
      { apNodeId: "ap-2", x: 19, y: 1 },
      { apNodeId: "ap-3", x: 10, y: 14 },
    ],
  },
  {
    ownerName: "Demo Restaurant Owner",
    venueName: "Demo Restaurant — Dining Room",
    floorWidth: 25,
    floorHeight: 18,
    apNodes: [
      { apNodeId: "ap-1", x: 2, y: 2 },
      { apNodeId: "ap-2", x: 23, y: 16 },
    ],
  },
];

/**
 * Idempotent: re-running against the same database does not duplicate
 * owners/venues. Idempotency is keyed on owner name, which is good enough
 * for a fixed, small seed script (not a general "find or create" utility).
 */
export function seedDemoData(db: DatabaseSync): void {
  const existingOwners = db.prepare("SELECT id, name FROM owners").all() as Array<{ id: string; name: string }>;
  const existingNames = new Set(existingOwners.map((o) => o.name));

  for (const demo of DEMO_OWNERS) {
    if (existingNames.has(demo.ownerName)) continue;

    const owner = createOwner(db, demo.ownerName);
    const venue = createVenue(db, owner.id, {
      name: demo.venueName,
      floorWidth: demo.floorWidth,
      floorHeight: demo.floorHeight,
    });
    for (const apNode of demo.apNodes) {
      createApNode(db, venue.id, apNode);
    }
  }
}

/** Run directly: `node src/seed.ts` (uses the default on-disk database). */
if (import.meta.url === `file://${process.argv[1]}`) {
  const { openDatabase } = await import("./db.ts");
  const db = openDatabase();
  seedDemoData(db);
  for (const demo of DEMO_OWNERS) {
    const owners = db.prepare("SELECT id FROM owners WHERE name = ?").all(demo.ownerName) as Array<{ id: string }>;
    const owner = owners[0];
    if (owner) {
      const venues = getVenuesForOwner(db, owner.id);
      console.log(`${demo.ownerName}: ${venues.length} venue(s)`);
    }
  }
  db.close();
}

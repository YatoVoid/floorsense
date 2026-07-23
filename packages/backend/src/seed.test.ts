import assert from "node:assert";
import { test } from "node:test";
import { openDatabase } from "./db.ts";
import { seedDemoData } from "./seed.ts";
import { getVenuesForOwner } from "./tenancy.ts";

test("seedDemoData creates the expected owners, venues, and ap nodes", () => {
  const db = openDatabase(":memory:");
  seedDemoData(db);

  const owners = db.prepare("SELECT id, name FROM owners").all() as Array<{ id: string; name: string }>;
  assert.strictEqual(owners.length, 2);

  for (const owner of owners) {
    const venues = getVenuesForOwner(db, owner.id);
    assert.strictEqual(venues.length, 1, `expected exactly 1 venue for ${owner.name}`);

    const apNodes = db.prepare("SELECT * FROM ap_nodes WHERE venue_id = ?").all(venues[0]?.id) as unknown[];
    assert.ok(apNodes.length >= 2, `expected at least 2 AP nodes for ${owner.name}`);
  }
  db.close();
});

test("seedDemoData is idempotent: running it twice does not duplicate owners", () => {
  const db = openDatabase(":memory:");
  seedDemoData(db);
  seedDemoData(db);

  const owners = db.prepare("SELECT id FROM owners").all() as unknown[];
  assert.strictEqual(owners.length, 2, "re-running the seed script must not create duplicate owners");
  db.close();
});

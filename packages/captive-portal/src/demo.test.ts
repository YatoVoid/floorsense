import assert from "node:assert";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import type { ApEvent } from "@floorsense/shared";
import { openDatabase, createOwner, createVenue, createApNode, ingestApEvent, hasConsent, getEventsForVenue } from "@floorsense/backend";
import { SimulatedApAdapter } from "@floorsense/ap-adapter-sim";
import { createCaptivePortalServer } from "./server.ts";
import { wireAdapterThroughPortal } from "./demo.ts";

/** Deterministic PRNG (mulberry32), matching the convention used in ap-adapter-sim's own tests. */
function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function setupVenue(db: ReturnType<typeof openDatabase>) {
  const owner = createOwner(db, "Demo Test Owner");
  const venue = createVenue(db, owner.id, { name: "Demo Test Venue", floorWidth: 20, floorHeight: 15 });
  const apNode = createApNode(db, venue.id, { apNodeId: "ap-1", x: 5, y: 5 });
  return { tenantId: owner.id, venueId: venue.id, apNode };
}

test("an adapter-shaped event routed directly to ingestApEvent, bypassing the portal, is rejected without prior consent", () => {
  const db = openDatabase(":memory:");
  const { tenantId, venueId, apNode } = setupVenue(db);

  const adapter = new SimulatedApAdapter({
    tenantId,
    venueId,
    apNodes: [{ apNodeId: apNode.apNodeId, x: apNode.x, y: apNode.y }],
    salt: "test-salt",
    deviceCount: 1,
    firstJoinProbabilityPerTick: 1,
    random: seededRandom(1),
  });

  let joinEvent: ApEvent | undefined;
  adapter.on("event", (event: ApEvent) => {
    if (event.type === "join" && !joinEvent) joinEvent = event;
  });
  adapter.tick();

  assert.ok(joinEvent, "expected the adapter to emit a join event on the first tick");
  const result = ingestApEvent(db, joinEvent);
  assert.strictEqual(result.accepted, false);
  assert.strictEqual(!result.accepted && result.reason, "no_consent");
  assert.strictEqual(getEventsForVenue(db, tenantId, venueId).length, 0);
  db.close();
});

test("wireAdapterThroughPortal buffers a device's events until its simulated consent flow completes, then ingests them", async () => {
  const db = openDatabase(":memory:");
  const { tenantId, venueId, apNode } = setupVenue(db);

  const server = createCaptivePortalServer(db, {
    tenantId,
    venueId,
    venueName: "Demo Test Venue",
    termsVersion: "v1",
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address() as AddressInfo;
  const portalBaseUrl = `http://127.0.0.1:${address.port}`;

  const adapter = new SimulatedApAdapter({
    tenantId,
    venueId,
    apNodes: [{ apNodeId: apNode.apNodeId, x: apNode.x, y: apNode.y }],
    salt: "test-salt",
    deviceCount: 1,
    firstJoinProbabilityPerTick: 1,
    meanDwellTicks: 100,
    random: seededRandom(2),
  });

  let seenDeviceId: string | undefined;
  adapter.on("event", (event: ApEvent) => {
    seenDeviceId = event.hashedDeviceId;
  });

  const { stats, drain } = wireAdapterThroughPortal(db, adapter, { portalBaseUrl, termsVersion: "v1" });

  for (let i = 0; i < 3; i++) adapter.tick();
  await drain();

  assert.ok(seenDeviceId, "expected at least one event to have been emitted");
  assert.strictEqual(stats.consentFlowsStarted, 1, "exactly one consent flow for the single simulated device");
  assert.ok(stats.ingested > 0, "expected at least one event to be ingested after consent completed");
  assert.strictEqual(hasConsent(db, tenantId, venueId, seenDeviceId as string), true);

  const storedEvents = getEventsForVenue(db, tenantId, venueId);
  assert.strictEqual(storedEvents.length, stats.ingested, "every successfully-ingested event must actually be persisted");

  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
});

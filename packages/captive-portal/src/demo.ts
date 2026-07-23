import type { AddressInfo } from "node:net";
import type { DatabaseSync } from "node:sqlite";
import type { ApEvent } from "@floorsense/shared";
import { ingestApEvent } from "@floorsense/backend";
import type { SimulatedApAdapter } from "@floorsense/ap-adapter-sim";

export interface PortalWiringStats {
  ingested: number;
  consentFlowsStarted: number;
}

export interface WireAdapterOptions {
  portalBaseUrl: string;
  termsVersion: string;
}

export interface WiredAdapter {
  stats: PortalWiringStats;
  /** Awaits every consent flow currently in flight. Call after ticking the adapter. */
  drain: () => Promise<void>;
}

/**
 * Wires a SimulatedApAdapter's emitted events through the captive portal's
 * real HTTP consent flow before any of them reach ingestApEvent. A device's
 * events are buffered — never dropped, never ingested early — until its
 * simulated "saw the splash page and tapped accept" round trip resolves,
 * mirroring how a real AP holds a device's traffic pre-consent rather than
 * letting it through provisionally.
 */
export function wireAdapterThroughPortal(
  db: DatabaseSync,
  adapter: SimulatedApAdapter,
  options: WireAdapterOptions
): WiredAdapter {
  const consented = new Set<string>();
  const inFlight = new Map<string, Promise<void>>();
  const pending = new Map<string, ApEvent[]>();
  const stats: PortalWiringStats = { ingested: 0, consentFlowsStarted: 0 };

  function ingest(event: ApEvent): void {
    const result = ingestApEvent(db, event);
    if (result.accepted) stats.ingested += 1;
  }

  async function runConsentFlow(hashedDeviceId: string): Promise<void> {
    stats.consentFlowsStarted += 1;
    await fetch(`${options.portalBaseUrl}/?deviceId=${encodeURIComponent(hashedDeviceId)}`);
    await fetch(`${options.portalBaseUrl}/consent/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hashedDeviceId, termsVersion: options.termsVersion }),
    });

    consented.add(hashedDeviceId);
    const buffered = pending.get(hashedDeviceId) ?? [];
    pending.delete(hashedDeviceId);
    for (const event of buffered) ingest(event);
    inFlight.delete(hashedDeviceId);
  }

  adapter.on("event", (event: ApEvent) => {
    const id = event.hashedDeviceId;

    if (consented.has(id)) {
      ingest(event);
      return;
    }

    const buffered = pending.get(id) ?? [];
    buffered.push(event);
    pending.set(id, buffered);

    if (!inFlight.has(id)) {
      inFlight.set(id, runConsentFlow(id));
    }
  });

  return {
    stats,
    drain: async () => {
      await Promise.all(inFlight.values());
    },
  };
}

/** Run directly: `node src/demo.ts` — a local, hardware-free end-to-end proof. */
if (import.meta.url === `file://${process.argv[1]}`) {
  const { openDatabase, createOwner, createVenue, createApNode } = await import("@floorsense/backend");
  const { SimulatedApAdapter } = await import("@floorsense/ap-adapter-sim");
  const { createCaptivePortalServer } = await import("./server.ts");

  const db = openDatabase(":memory:");
  const owner = createOwner(db, "Demo Portal Owner");
  const venue = createVenue(db, owner.id, { name: "Demo Portal Venue", floorWidth: 20, floorHeight: 15 });
  const apNodeRecords = [
    createApNode(db, venue.id, { apNodeId: "ap-1", x: 1, y: 1 }),
    createApNode(db, venue.id, { apNodeId: "ap-2", x: 19, y: 14 }),
  ];

  const server = createCaptivePortalServer(db, {
    tenantId: owner.id,
    venueId: venue.id,
    venueName: venue.name,
    termsVersion: "v1",
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address() as AddressInfo;
  const portalBaseUrl = `http://127.0.0.1:${address.port}`;

  const adapter = new SimulatedApAdapter({
    tenantId: owner.id,
    venueId: venue.id,
    apNodes: apNodeRecords.map((n) => ({ apNodeId: n.apNodeId, x: n.x, y: n.y })),
    salt: "demo-salt",
    deviceCount: 5,
    firstJoinProbabilityPerTick: 0.3,
    rejoinProbabilityPerTick: 0.1,
    meanDwellTicks: 3,
  });

  const { stats, drain } = wireAdapterThroughPortal(db, adapter, { portalBaseUrl, termsVersion: "v1" });

  for (let i = 0; i < 30; i++) adapter.tick();
  await drain();

  console.log(`Consent flows started: ${stats.consentFlowsStarted}`);
  console.log(`Events ingested (post-consent only): ${stats.ingested}`);

  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
}

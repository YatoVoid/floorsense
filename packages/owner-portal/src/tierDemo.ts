import type { AddressInfo } from "node:net";
import { hashDeviceId } from "@floorsense/shared";
import {
  openDatabase,
  createOwnerWithPassword,
  createVenue,
  createApNode,
  recordConsentGrant,
  ingestApEvent,
  setOwnerTier,
  type SubscriptionTier,
} from "@floorsense/backend";
import { createOwnerPortalServer } from "./server.ts";

interface TierResult {
  tier: SubscriptionTier;
  heatmapStatus: number;
  statsPerDeviceCount: number;
  statsHourOfDayTotal: number;
  statsNewDeviceCount: number;
}

export interface TierDemoResult {
  basic: TierResult;
  standard: TierResult;
  premium: TierResult;
}

/** Three owners, each with a venue carrying identical event data, checked over real HTTP for real per-tier response differences. */
export async function runTierDemo(): Promise<TierDemoResult> {
  const db = openDatabase(":memory:");

  function seedOwner(name: string, tier: SubscriptionTier) {
    const owner = createOwnerWithPassword(db, name, "demo-password-123");
    setOwnerTier(db, owner.id, tier);
    const venue = createVenue(db, owner.id, { name: `${name} Venue`, floorWidth: 10, floorHeight: 10 });
    const apNode = createApNode(db, venue.id, { apNodeId: "ap-1", x: 0, y: 0 });

    const hashedDeviceId = hashDeviceId("aa:bb:cc:dd:ee:ff", `tier-demo-salt-${tier}`);
    recordConsentGrant(db, { tenantId: owner.id, venueId: venue.id, hashedDeviceId, termsVersion: "v1" });
    ingestApEvent(db, { type: "join", hashedDeviceId, tenantId: owner.id, venueId: venue.id, apNodeId: apNode.apNodeId, timestamp: 1000 });
    ingestApEvent(db, {
      type: "signal_reading",
      hashedDeviceId,
      tenantId: owner.id,
      venueId: venue.id,
      apNodeId: apNode.apNodeId,
      timestamp: 2000,
      rssi: -55,
    });
    ingestApEvent(db, { type: "leave", hashedDeviceId, tenantId: owner.id, venueId: venue.id, apNodeId: apNode.apNodeId, timestamp: 5000 });

    return { name, venue };
  }

  const owners = {
    basic: seedOwner("Tier Demo Basic Owner", "basic"),
    standard: seedOwner("Tier Demo Standard Owner", "standard"),
    premium: seedOwner("Tier Demo Premium Owner", "premium"),
  };

  const server = createOwnerPortalServer(db);
  await new Promise<void>((resolve) => server.listen(0, resolve));

  try {
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    async function checkTier(tier: SubscriptionTier): Promise<TierResult> {
      const { name, venue } = owners[tier];
      const loginRes = await fetch(`${baseUrl}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, password: "demo-password-123" }),
      });
      if (!loginRes.ok) throw new Error(`login failed for ${tier}: ${loginRes.status}`);
      const { token } = (await loginRes.json()) as { token: string };
      const authHeaders = { Authorization: `Bearer ${token}` };

      const heatmapRes = await fetch(`${baseUrl}/venues/${venue.id}/heatmap`, { headers: authHeaders });

      const statsRes = await fetch(`${baseUrl}/venues/${venue.id}/return-visit-stats`, { headers: authHeaders });
      if (!statsRes.ok) throw new Error(`return-visit-stats fetch failed for ${tier}: ${statsRes.status}`);
      const stats = (await statsRes.json()) as {
        perDevice: unknown[];
        hourOfDayDistribution: number[];
        newDeviceCount: number;
      };

      return {
        tier,
        heatmapStatus: heatmapRes.status,
        statsPerDeviceCount: stats.perDevice.length,
        statsHourOfDayTotal: stats.hourOfDayDistribution.reduce((a, b) => a + b, 0),
        statsNewDeviceCount: stats.newDeviceCount,
      };
    }

    return {
      basic: await checkTier("basic"),
      standard: await checkTier("standard"),
      premium: await checkTier("premium"),
    };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
}

/** Run directly: `node src/tierDemo.ts` */
if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runTierDemo();
  for (const tier of ["basic", "standard", "premium"] as const) {
    const r = result[tier];
    console.log(
      `${tier}: heatmap=${r.heatmapStatus}, perDeviceCount=${r.statsPerDeviceCount}, ` +
        `hourOfDayTotal=${r.statsHourOfDayTotal}, newDeviceCount=${r.statsNewDeviceCount}`
    );
  }
}

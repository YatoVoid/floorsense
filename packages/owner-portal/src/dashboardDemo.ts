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
} from "@floorsense/backend";
import { createOwnerPortalServer } from "./server.ts";

export interface DashboardDemoResult {
  dashboardPageStatus: number;
  dashboardPageIsHtml: boolean;
  premiumOwner: { venueCount: number; heatmapStatus: number; statsPerDeviceCount: number };
  basicOwner: { venueCount: number; heatmapStatus: number; statsPerDeviceCount: number };
}

/** Checks the JSON/HTML contracts the dashboard page's client script relies on, for a premium and a basic owner. Data contract only, no real browser. */
export async function runDashboardDemo(): Promise<DashboardDemoResult> {
  const db = openDatabase(":memory:");

  function seedOwner(name: string, tier: "basic" | "premium") {
    const owner = createOwnerWithPassword(db, name, "demo-password-123");
    setOwnerTier(db, owner.id, tier);
    const venue = createVenue(db, owner.id, { name: `${name} Venue`, floorWidth: 10, floorHeight: 10 });
    const apNode = createApNode(db, venue.id, { apNodeId: "ap-1", x: 0, y: 0 });

    const hashedDeviceId = hashDeviceId("aa:bb:cc:dd:ee:ff", `dashboard-demo-salt-${tier}`);
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

    return { name };
  }

  seedOwner("Dashboard Demo Premium Owner", "premium");
  seedOwner("Dashboard Demo Basic Owner", "basic");

  const server = createOwnerPortalServer(db);
  await new Promise<void>((resolve) => server.listen(0, resolve));

  try {
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const pageRes = await fetch(baseUrl);
    const dashboardPageStatus = pageRes.status;
    const dashboardPageIsHtml = (pageRes.headers.get("content-type") ?? "").includes("text/html");
    await pageRes.text();

    async function checkOwner(name: string) {
      const loginRes = await fetch(`${baseUrl}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, password: "demo-password-123" }),
      });
      if (!loginRes.ok) throw new Error(`login failed for ${name}: ${loginRes.status}`);
      const { token } = (await loginRes.json()) as { token: string };
      const authHeaders = { Authorization: `Bearer ${token}` };

      const venuesRes = await fetch(`${baseUrl}/venues`, { headers: authHeaders });
      if (!venuesRes.ok) throw new Error(`/venues failed for ${name}: ${venuesRes.status}`);
      const venues = (await venuesRes.json()) as Array<{ id: string }>;
      const venueId = venues[0]!.id;

      const heatmapRes = await fetch(`${baseUrl}/venues/${venueId}/heatmap`, { headers: authHeaders });
      await heatmapRes.json();

      const statsRes = await fetch(`${baseUrl}/venues/${venueId}/return-visit-stats`, { headers: authHeaders });
      if (!statsRes.ok) throw new Error(`return-visit-stats failed for ${name}: ${statsRes.status}`);
      const stats = (await statsRes.json()) as { perDevice: unknown[] };

      return { venueCount: venues.length, heatmapStatus: heatmapRes.status, statsPerDeviceCount: stats.perDevice.length };
    }

    const premiumOwner = await checkOwner("Dashboard Demo Premium Owner");
    const basicOwner = await checkOwner("Dashboard Demo Basic Owner");

    return { dashboardPageStatus, dashboardPageIsHtml, premiumOwner, basicOwner };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
}

/** Run directly: `node src/dashboardDemo.ts` */
if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runDashboardDemo();
  console.log(`GET / status=${result.dashboardPageStatus}, isHtml=${result.dashboardPageIsHtml}`);
  console.log(`Premium owner: ${JSON.stringify(result.premiumOwner)}`);
  console.log(`Basic owner: ${JSON.stringify(result.basicOwner)}`);
  console.log("NOTE: this proves the data contract only. Opening the page in a real browser is still a manual step.");
}

import type { AddressInfo } from "node:net";
import { openDatabase } from "@floorsense/backend";
import { createOwnerPortalServer } from "./server.ts";
import { buildVenueCreationPayload } from "./dashboardPage.ts";

export interface OnboardingDemoResult {
  registerStatus: number;
  venueCreateStatus: number;
  venuesAfterCreation: number;
  heatmapStatus: number;
  statsStatus: number;
}

/**
 * End-to-end proof that a genuinely NEW owner (never pre-seeded via
 * createOwnerWithPassword/createVenue directly) can reach the whole system
 * through nothing but its own public HTTP surface: register -> create a
 * first venue -> reach the existing heatmap/return-visit-stats endpoints.
 * This is the concrete proof the "dead end" gap (no signup path existed
 * before KR10) is actually closed, not just that the two new routes
 * individually return 2xx in isolation. Real-browser interaction with the
 * register toggle and venue-creation form remains a manual smoke-check
 * step, not covered here (no headless-browser dependency introduced).
 */
export async function runOnboardingDemo(): Promise<OnboardingDemoResult> {
  const db = openDatabase(":memory:");
  const server = createOwnerPortalServer(db);
  await new Promise<void>((resolve) => server.listen(0, resolve));

  try {
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const registerRes = await fetch(`${baseUrl}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Brand New Onboarding Owner", password: "a-real-password-123" }),
    });
    if (!registerRes.ok) throw new Error(`registration failed: ${registerRes.status}`);
    const { token } = (await registerRes.json()) as { token: string };
    const authHeaders = { Authorization: `Bearer ${token}` };

    const venuePayload = buildVenueCreationPayload({ name: "My First Real Venue", floorWidth: "15", floorHeight: "10" });
    if (!venuePayload.valid) throw new Error(`unexpected client-side validation failure: ${venuePayload.error}`);

    const venueCreateRes = await fetch(`${baseUrl}/venues`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify(venuePayload.payload),
    });
    if (!venueCreateRes.ok) throw new Error(`venue creation failed: ${venueCreateRes.status}`);
    const venue = (await venueCreateRes.json()) as { id: string };

    const venuesRes = await fetch(`${baseUrl}/venues`, { headers: authHeaders });
    const venues = (await venuesRes.json()) as unknown[];

    const heatmapRes = await fetch(`${baseUrl}/venues/${venue.id}/heatmap`, { headers: authHeaders });
    const statsRes = await fetch(`${baseUrl}/venues/${venue.id}/return-visit-stats`, { headers: authHeaders });

    return {
      registerStatus: registerRes.status,
      venueCreateStatus: venueCreateRes.status,
      venuesAfterCreation: venues.length,
      heatmapStatus: heatmapRes.status,
      statsStatus: statsRes.status,
    };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
}

/** Run directly: `node src/onboardingDemo.ts` */
if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runOnboardingDemo();
  console.log(`Register: ${result.registerStatus}`);
  console.log(`Venue create: ${result.venueCreateStatus}`);
  console.log(`Venues after creation: ${result.venuesAfterCreation}`);
  console.log(`Heatmap: ${result.heatmapStatus} (402 expected — a brand-new owner defaults to basic tier)`);
  console.log(`Return-visit stats: ${result.statsStatus}`);
  console.log("NOTE: this proves the data contract only — the register toggle and venue-creation form's real browser behavior is a manual step, not covered here.");
}

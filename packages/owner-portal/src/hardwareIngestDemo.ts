import type { AddressInfo } from "node:net";
import { hashDeviceId } from "@floorsense/shared";
import { openDatabase, recordConsentGrant } from "@floorsense/backend";
import { createOwnerPortalServer } from "./server.ts";

export interface HardwareIngestDemoResult {
  hardwareTokenLength: number;
  joinStatus: number;
  signalReadingStatus: number;
  leaveStatus: number;
  newDeviceCountAfterEvents: number;
}

/** Proves the exact contract real ESP32 firmware will use: read a venue's hardware token over the owner's own authenticated API, then report presence events over plain HTTP with no owner session at all. */
export async function runHardwareIngestDemo(): Promise<HardwareIngestDemoResult> {
  const db = openDatabase(":memory:");
  const server = createOwnerPortalServer(db);
  await new Promise<void>((resolve) => server.listen(0, resolve));

  try {
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const registerRes = await fetch(`${baseUrl}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Hardware Demo Owner", password: "demo-password-123", tier: "basic" }),
    });
    const { token: ownerToken } = (await registerRes.json()) as { token: string };
    const authHeaders = { Authorization: `Bearer ${ownerToken}` };

    const venueRes = await fetch(`${baseUrl}/venues`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify({ name: "Hardware Demo Venue", floorWidth: 10, floorHeight: 10 }),
    });
    const venue = (await venueRes.json()) as { id: string };

    await fetch(`${baseUrl}/venues/${venue.id}/ap-nodes`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify({ apNodeId: "ap-1", x: 0, y: 0 }),
    });

    // Read the hardware token exactly the way a real owner would: through
    // their own authenticated dashboard API, not a direct DB peek.
    const venuesRes = await fetch(`${baseUrl}/venues`, { headers: authHeaders });
    const venues = (await venuesRes.json()) as Array<{ id: string; hardwareToken: string }>;
    const hardwareToken = venues[0]!.hardwareToken;

    const rawMac = "aa:bb:cc:dd:ee:ff";
    const hashedDeviceId = hashDeviceId(rawMac, hardwareToken);
    const ownerRow = db.prepare("SELECT id FROM owners WHERE name = ?").get("Hardware Demo Owner") as
      | { id: string }
      | undefined;
    if (!ownerRow) throw new Error("expected the registered owner to exist in the database");
    recordConsentGrant(db, { tenantId: ownerRow.id, venueId: venue.id, hashedDeviceId, termsVersion: "v1" });

    async function sendEvent(body: Record<string, unknown>): Promise<number> {
      const res = await fetch(`${baseUrl}/hardware/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ venueId: venue.id, hardwareToken, apNodeId: "ap-1", deviceMac: rawMac, ...body }),
      });
      return res.status;
    }

    const joinStatus = await sendEvent({ eventType: "join" });
    const signalReadingStatus = await sendEvent({ eventType: "signal_reading", rssi: -55 });
    const leaveStatus = await sendEvent({ eventType: "leave" });

    const statsRes = await fetch(`${baseUrl}/venues/${venue.id}/return-visit-stats`, { headers: authHeaders });
    const stats = (await statsRes.json()) as { newDeviceCount: number };

    return {
      hardwareTokenLength: hardwareToken.length,
      joinStatus,
      signalReadingStatus,
      leaveStatus,
      newDeviceCountAfterEvents: stats.newDeviceCount,
    };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
}

/** Run directly: `node src/hardwareIngestDemo.ts` */
if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runHardwareIngestDemo();
  console.log(`Hardware token length: ${result.hardwareTokenLength} chars`);
  console.log(`join=${result.joinStatus}, signal_reading=${result.signalReadingStatus}, leave=${result.leaveStatus}`);
  console.log(`New device count after events: ${result.newDeviceCountAfterEvents}`);
}

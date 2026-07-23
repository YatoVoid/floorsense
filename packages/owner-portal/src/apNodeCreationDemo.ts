import type { AddressInfo } from "node:net";
import { openDatabase, fitCalibrationProfile } from "@floorsense/backend";
import { createOwnerPortalServer } from "./server.ts";
import { buildApNodeCreationPayload, buildCalibrationSamplePayload } from "./dashboardPage.ts";

export interface ApNodeCreationDemoResult {
  apNodesBeforeCreation: number;
  apNodeCreateStatus: number;
  apNodesAfterCreation: number;
  calibrationSamplesSubmitted: number;
  fitSucceeded: boolean;
}

/**
 * End-to-end proof that the originally reported bug is fixed: a brand-new
 * owner (registered fresh, never pre-seeded) can register, create a venue,
 * add an AP node through the real endpoint, and immediately use it to
 * submit calibration samples that fit a real profile. Before this KR, step
 * 3 had no HTTP route at all, so the calibration form's AP-node dropdown
 * was always empty for a new signup.
 */
export async function runApNodeCreationDemo(): Promise<ApNodeCreationDemoResult> {
  const db = openDatabase(":memory:");
  const server = createOwnerPortalServer(db);
  await new Promise<void>((resolve) => server.listen(0, resolve));

  try {
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const registerRes = await fetch(`${baseUrl}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "AP Node Creation Demo Owner", password: "demo-password-123" }),
    });
    if (!registerRes.ok) throw new Error(`registration failed: ${registerRes.status}`);
    const { token } = (await registerRes.json()) as { token: string };
    const authHeaders = { Authorization: `Bearer ${token}` };

    const venueRes = await fetch(`${baseUrl}/venues`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify({ name: "AP Node Creation Demo Venue", floorWidth: 20, floorHeight: 15 }),
    });
    if (!venueRes.ok) throw new Error(`venue creation failed: ${venueRes.status}`);
    const venue = (await venueRes.json()) as { id: string };

    const beforeRes = await fetch(`${baseUrl}/venues/${venue.id}/ap-nodes`, { headers: authHeaders });
    const apNodesBeforeCreation = ((await beforeRes.json()) as unknown[]).length;

    const apNodePayload = buildApNodeCreationPayload({ apNodeId: "ap-1", x: 0, y: 0 });
    if (!apNodePayload.valid) throw new Error(`unexpected client-side validation failure: ${apNodePayload.error}`);

    const createRes = await fetch(`${baseUrl}/venues/${venue.id}/ap-nodes`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify(apNodePayload.payload),
    });
    const apNodeCreateStatus = createRes.status;

    const afterRes = await fetch(`${baseUrl}/venues/${venue.id}/ap-nodes`, { headers: authHeaders });
    const apNodesAfterCreation = ((await afterRes.json()) as unknown[]).length;

    const referenceRssiAt1m = -40;
    const pathLossExponent = 2.7;
    const rssiAtDistance = (distance: number) =>
      referenceRssiAt1m - 10 * pathLossExponent * Math.log10(Math.max(distance, 0.1));

    let calibrationSamplesSubmitted = 0;
    for (const distance of [1, 2, 4, 8, 16]) {
      const samplePayload = buildCalibrationSamplePayload({
        apNodeId: "ap-1",
        rssi: String(rssiAtDistance(distance)),
        knownX: distance,
        knownY: 0,
      });
      if (!samplePayload.valid) throw new Error(`unexpected calibration validation failure: ${samplePayload.error}`);

      const sampleRes = await fetch(`${baseUrl}/venues/${venue.id}/calibration-samples`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify(samplePayload.payload),
      });
      if (!sampleRes.ok) throw new Error(`calibration sample submission failed: ${sampleRes.status}`);
      calibrationSamplesSubmitted += 1;
    }

    // fitCalibrationProfile needs a real ownerId, not the bearer token -
    // fetch it via a login-adjacent path is unnecessary here since we
    // control the DB directly in this same process.
    const ownersRow = db.prepare("SELECT id FROM owners WHERE name = ?").get("AP Node Creation Demo Owner") as
      | { id: string }
      | undefined;
    if (!ownersRow) throw new Error("expected the registered owner to exist in the database");
    const fitted = fitCalibrationProfile(db, ownersRow.id, venue.id);

    return {
      apNodesBeforeCreation,
      apNodeCreateStatus,
      apNodesAfterCreation,
      calibrationSamplesSubmitted,
      fitSucceeded: fitted !== null,
    };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
}

/** Run directly: `node src/apNodeCreationDemo.ts` */
if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runApNodeCreationDemo();
  console.log(`AP nodes before creation: ${result.apNodesBeforeCreation} (this was the empty dropdown before this KR)`);
  console.log(`AP node create status: ${result.apNodeCreateStatus}`);
  console.log(`AP nodes after creation: ${result.apNodesAfterCreation}`);
  console.log(`Calibration samples submitted: ${result.calibrationSamplesSubmitted}`);
  console.log(`Calibration fit succeeded: ${result.fitSucceeded}`);
}

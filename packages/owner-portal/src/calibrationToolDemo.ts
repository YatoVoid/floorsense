import type { AddressInfo } from "node:net";
import { openDatabase, createOwnerWithPassword, createVenue, createApNode, fitCalibrationProfile } from "@floorsense/backend";
import { createOwnerPortalServer } from "./server.ts";
import { buildCalibrationSamplePayload } from "./dashboardPage.ts";

const GROUND_TRUTH_REFERENCE_RSSI_AT_1M = -40;
const GROUND_TRUTH_PATH_LOSS_EXPONENT = 2.7;

function rssiAtDistance(distance: number): number {
  return (
    GROUND_TRUTH_REFERENCE_RSSI_AT_1M - 10 * GROUND_TRUTH_PATH_LOSS_EXPONENT * Math.log10(Math.max(distance, 0.1))
  );
}

export interface CalibrationToolDemoResult {
  apNodeCount: number;
  samplesSubmitted: number;
  fittedReferenceRssiAt1m: number;
  fittedPathLossExponent: number;
}

/**
 * End-to-end proof of the exact data contract the new calibration-tool UI
 * (KR9) depends on: discovers a venue's real AP nodes over real HTTP via
 * GET /venues/:id/ap-nodes, builds each calibration sample's request body
 * through the SAME buildCalibrationSamplePayload function the browser form
 * calls (not a hand-rolled equivalent), and submits it through the
 * existing POST /venues/:venueId/calibration-samples endpoint (KR5) —
 * confirming fitCalibrationProfile (KR3) successfully fits a profile from
 * data that arrived entirely through this path. This proves the data
 * contract only; actually clicking through the floor plan in a real
 * browser remains a manual step, not covered here (no headless-browser
 * dependency is introduced in this repo).
 */
export async function runCalibrationToolDemo(): Promise<CalibrationToolDemoResult> {
  const db = openDatabase(":memory:");
  const owner = createOwnerWithPassword(db, "Calibration Tool Demo Owner", "demo-password-123");
  const venue = createVenue(db, owner.id, { name: "Calibration Tool Demo Venue", floorWidth: 20, floorHeight: 15 });
  createApNode(db, venue.id, { apNodeId: "ap-1", x: 0, y: 0 });

  const server = createOwnerPortalServer(db);
  await new Promise<void>((resolve) => server.listen(0, resolve));

  try {
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const loginRes = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Calibration Tool Demo Owner", password: "demo-password-123" }),
    });
    if (!loginRes.ok) throw new Error(`login failed: ${loginRes.status}`);
    const { token } = (await loginRes.json()) as { token: string };
    const authHeaders = { Authorization: `Bearer ${token}` };

    const apNodesRes = await fetch(`${baseUrl}/venues/${venue.id}/ap-nodes`, { headers: authHeaders });
    if (!apNodesRes.ok) throw new Error(`ap-nodes fetch failed: ${apNodesRes.status}`);
    const apNodes = (await apNodesRes.json()) as Array<{ apNodeId: string }>;
    const apNode = apNodes[0];
    if (!apNode) throw new Error("expected at least one AP node");

    const distances = [1, 2, 4, 8, 16];
    let samplesSubmitted = 0;
    for (const distance of distances) {
      const validation = buildCalibrationSamplePayload({
        apNodeId: apNode.apNodeId,
        rssi: String(rssiAtDistance(distance)),
        knownX: distance,
        knownY: 0,
      });
      if (!validation.valid) throw new Error(`unexpected client-side validation failure: ${validation.error}`);

      const res = await fetch(`${baseUrl}/venues/${venue.id}/calibration-samples`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify(validation.payload),
      });
      if (!res.ok) throw new Error(`calibration sample submission failed: ${res.status}`);
      samplesSubmitted += 1;
    }

    const fitted = fitCalibrationProfile(db, owner.id, venue.id);
    if (!fitted) throw new Error("expected calibration to fit successfully from samples submitted via the calibration tool's own payload builder");

    return {
      apNodeCount: apNodes.length,
      samplesSubmitted,
      fittedReferenceRssiAt1m: fitted.referenceRssiAt1m,
      fittedPathLossExponent: fitted.pathLossExponent,
    };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
}

/** Run directly: `node src/calibrationToolDemo.ts` */
if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runCalibrationToolDemo();
  console.log(`AP nodes discovered: ${result.apNodeCount}`);
  console.log(`Calibration samples submitted via buildCalibrationSamplePayload: ${result.samplesSubmitted}`);
  console.log(
    `Fitted profile: referenceRssiAt1m=${result.fittedReferenceRssiAt1m.toFixed(3)}, ` +
      `pathLossExponent=${result.fittedPathLossExponent.toFixed(3)}`
  );
  console.log(
    "NOTE: this proves the data contract only — actually clicking through the floor plan in a real browser is a manual step, not covered here."
  );
}

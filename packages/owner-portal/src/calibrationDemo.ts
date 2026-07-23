import type { AddressInfo } from "node:net";
import { openDatabase, createOwnerWithPassword, createVenue, createApNode, fitCalibrationProfile } from "@floorsense/backend";
import { createOwnerPortalServer } from "./server.ts";

const GROUND_TRUTH_REFERENCE_RSSI_AT_1M = -40;
const GROUND_TRUTH_PATH_LOSS_EXPONENT = 2.7;

function rssiAtDistance(distance: number): number {
  return (
    GROUND_TRUTH_REFERENCE_RSSI_AT_1M - 10 * GROUND_TRUTH_PATH_LOSS_EXPONENT * Math.log10(Math.max(distance, 0.1))
  );
}

export interface CalibrationDemoResult {
  fittedReferenceRssiAt1m: number;
  fittedPathLossExponent: number;
  samplesSubmitted: number;
}

/**
 * End-to-end proof that the login -> authenticated write -> existing
 * backend logic path (KR5) actually works: logs in over real HTTP,
 * submits several calibration samples over real HTTP using the returned
 * session token, then confirms fitCalibrationProfile (KR3) successfully
 * fits a profile from them — not from a coincidental match with the
 * default profile (samples are generated from the same ground-truth
 * constants the default happens to share, but fitCalibrationProfile is
 * still required to return non-null, proving a real fit occurred).
 */
export async function runCalibrationDemo(): Promise<CalibrationDemoResult> {
  const db = openDatabase(":memory:");
  const owner = createOwnerWithPassword(db, "Calibration Demo Owner", "demo-password-123");
  const venue = createVenue(db, owner.id, { name: "Calibration Demo Venue", floorWidth: 20, floorHeight: 15 });
  const apNode = createApNode(db, venue.id, { apNodeId: "ap-1", x: 0, y: 0 });

  const server = createOwnerPortalServer(db);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const loginRes = await fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Calibration Demo Owner", password: "demo-password-123" }),
  });
  if (!loginRes.ok) throw new Error(`login failed: ${loginRes.status}`);
  const { token } = (await loginRes.json()) as { token: string };

  const distances = [1, 2, 4, 8, 16];
  for (const distance of distances) {
    const res = await fetch(`${baseUrl}/venues/${venue.id}/calibration-samples`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ apNodeId: apNode.apNodeId, rssi: rssiAtDistance(distance), knownX: distance, knownY: 0 }),
    });
    if (!res.ok) throw new Error(`calibration sample submission failed: ${res.status}`);
  }

  const fitted = fitCalibrationProfile(db, owner.id, venue.id);
  if (!fitted) throw new Error("expected calibration to fit successfully from samples submitted over HTTP");

  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();

  return {
    fittedReferenceRssiAt1m: fitted.referenceRssiAt1m,
    fittedPathLossExponent: fitted.pathLossExponent,
    samplesSubmitted: distances.length,
  };
}

/** Run directly: `node src/calibrationDemo.ts` */
if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runCalibrationDemo();
  console.log(`Submitted ${result.samplesSubmitted} calibration samples over real HTTP`);
  console.log(
    `Fitted profile: referenceRssiAt1m=${result.fittedReferenceRssiAt1m.toFixed(3)}, ` +
      `pathLossExponent=${result.fittedPathLossExponent.toFixed(3)}`
  );
}

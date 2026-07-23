import type { AddressInfo } from "node:net";
import { pathLossRssi, SimulatedApAdapter } from "@floorsense/ap-adapter-sim";
import {
  openDatabase,
  createOwner,
  createVenue,
  createApNode,
  recordCalibrationSample,
  fitCalibrationProfile,
  estimateCurrentPosition,
} from "@floorsense/backend";
import { createCaptivePortalServer } from "./server.ts";
import { wireAdapterThroughPortal } from "./demo.ts";

/** Fixed at 0.5 so both the noise term and position jitter cancel to exactly 0, giving an exact result to check instead of a statistical one. */
const NO_NOISE = () => 0.5;

export interface PositioningDemoResult {
  groundTruth: { x: number; y: number };
  estimate: ReturnType<typeof estimateCurrentPosition>;
  distanceError: number;
}

/** Runs a simulated device through the real consent flow and checks the recovered position against the simulator's own ground truth. */
export async function runPositioningDemo(): Promise<PositioningDemoResult> {
  const db = openDatabase(":memory:");
  const owner = createOwner(db, "Positioning Demo Owner");
  const venue = createVenue(db, owner.id, { name: "Positioning Demo Venue", floorWidth: 20, floorHeight: 15 });
  const apNodeRecords = [
    createApNode(db, venue.id, { apNodeId: "ap-1", x: 0, y: 0 }),
    createApNode(db, venue.id, { apNodeId: "ap-2", x: 20, y: 0 }),
    createApNode(db, venue.id, { apNodeId: "ap-3", x: 10, y: 15 }),
  ];

  const calibrationPositions = [
    { x: 2, y: 2 },
    { x: 5, y: 5 },
    { x: 8, y: 3 },
    { x: 12, y: 8 },
    { x: 15, y: 1 },
    { x: 3, y: 12 },
  ];
  for (const pos of calibrationPositions) {
    for (const node of apNodeRecords) {
      const dist = Math.hypot(pos.x - node.x, pos.y - node.y);
      recordCalibrationSample(db, {
        tenantId: owner.id,
        venueId: venue.id,
        apNodeId: node.apNodeId,
        rssi: pathLossRssi(dist, NO_NOISE),
        knownX: pos.x,
        knownY: pos.y,
      });
    }
  }
  const fitted = fitCalibrationProfile(db, owner.id, venue.id);
  if (!fitted) throw new Error("expected calibration to fit successfully from 18 synthetic samples");

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
    salt: "positioning-demo-salt",
    deviceCount: 1,
    floorWidth: 20,
    floorHeight: 15,
    firstJoinProbabilityPerTick: 1,
    meanDwellTicks: 100,
    random: NO_NOISE,
  });

  const { drain } = wireAdapterThroughPortal(db, adapter, { portalBaseUrl, termsVersion: "v1" });
  for (let i = 0; i < 3; i++) adapter.tick();
  await drain();

  const devices = adapter.getGroundTruthPositions();
  const device = devices[0];
  if (!device || !device.joined) throw new Error("expected the single simulated device to have joined");
  const groundTruth = { x: device.x, y: device.y };

  const estimate = estimateCurrentPosition(db, owner.id, venue.id, device.hashedDeviceId);
  if (estimate.confidence === "no-data") throw new Error("expected a real position estimate, got no-data");

  const distanceError = Math.hypot(estimate.x - groundTruth.x, estimate.y - groundTruth.y);

  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();

  return { groundTruth, estimate, distanceError };
}

/** Run directly: `node src/positioningDemo.ts` */
if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runPositioningDemo();
  console.log(`Ground truth: (${result.groundTruth.x}, ${result.groundTruth.y})`);
  console.log(
    `Estimate: confidence=${result.estimate.confidence}` +
      (result.estimate.confidence === "no-data" ? "" : ` (${result.estimate.x.toFixed(3)}, ${result.estimate.y.toFixed(3)})`)
  );
  console.log(`Distance error: ${result.distanceError.toFixed(4)} m`);
}

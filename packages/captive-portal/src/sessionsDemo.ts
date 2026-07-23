import type { AddressInfo } from "node:net";
import type { ApEvent } from "@floorsense/shared";
import { SimulatedApAdapter } from "@floorsense/ap-adapter-sim";
import {
  openDatabase,
  createOwner,
  createVenue,
  createApNode,
  getSessionsForVenue,
  computeReturnVisitStats,
  SESSION_GAP_MS,
} from "@floorsense/backend";
import { createCaptivePortalServer } from "./server.ts";
import { wireAdapterThroughPortal } from "./demo.ts";

const NO_NOISE = () => 0.5;

export interface SessionsDemoResult {
  groundTruthJoinCount: number;
  groundTruthLeaveCount: number;
  reconstructedSessionCount: number;
  isReturning: boolean;
  visitCount: number;
}

/** Runs a simulated device through two visits (using the adapter's injectable clock to skip past SESSION_GAP_MS) and checks session/return-visit reconstruction against an independently counted join/leave total. */
export async function runSessionsDemo(): Promise<SessionsDemoResult> {
  const db = openDatabase(":memory:");
  const owner = createOwner(db, "Sessions Demo Owner");
  const venue = createVenue(db, owner.id, { name: "Sessions Demo Venue", floorWidth: 20, floorHeight: 15 });
  const apNode = createApNode(db, venue.id, { apNodeId: "ap-1", x: 0, y: 0 });

  const server = createCaptivePortalServer(db, {
    tenantId: owner.id,
    venueId: venue.id,
    venueName: venue.name,
    termsVersion: "v1",
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address() as AddressInfo;
  const portalBaseUrl = `http://127.0.0.1:${address.port}`;

  let currentTime = 1_700_000_000_000;
  const adapter = new SimulatedApAdapter({
    tenantId: owner.id,
    venueId: venue.id,
    apNodes: [{ apNodeId: apNode.apNodeId, x: apNode.x, y: apNode.y }],
    salt: "sessions-demo-salt",
    deviceCount: 1,
    floorWidth: 20,
    floorHeight: 15,
    firstJoinProbabilityPerTick: 1,
    rejoinProbabilityPerTick: 1,
    meanDwellTicks: 2,
    random: NO_NOISE,
    now: () => currentTime,
  });

  let groundTruthJoinCount = 0;
  let groundTruthLeaveCount = 0;
  adapter.on("event", (event: ApEvent) => {
    if (event.type === "join") groundTruthJoinCount += 1;
    if (event.type === "leave") groundTruthLeaveCount += 1;
  });

  const { drain } = wireAdapterThroughPortal(db, adapter, { portalBaseUrl, termsVersion: "v1" });

  // Visit 1: join then leave.
  adapter.tick();
  currentTime += 1000;
  adapter.tick();
  await drain();

  // Jump the clock so visit 2 counts as a real gap, not just a later tick.
  currentTime += SESSION_GAP_MS + 60_000;

  // Visit 2: same device rejoins, then leaves.
  adapter.tick();
  currentTime += 1000;
  adapter.tick();
  await drain();

  const sessions = getSessionsForVenue(db, owner.id, venue.id);
  const stats = computeReturnVisitStats(db, owner.id, venue.id);

  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();

  const deviceStats = stats.perDevice[0];
  return {
    groundTruthJoinCount,
    groundTruthLeaveCount,
    reconstructedSessionCount: sessions.length,
    isReturning: deviceStats?.isReturning ?? false,
    visitCount: deviceStats?.visitCount ?? 0,
  };
}

/** Run directly: `node src/sessionsDemo.ts` */
if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runSessionsDemo();
  console.log(`Ground truth: ${result.groundTruthJoinCount} joins, ${result.groundTruthLeaveCount} leaves`);
  console.log(`Reconstructed sessions: ${result.reconstructedSessionCount}`);
  console.log(`Return-visit stats: visitCount=${result.visitCount}, isReturning=${result.isReturning}`);
}

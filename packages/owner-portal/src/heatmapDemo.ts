import type { AddressInfo } from "node:net";
import { hashDeviceId } from "@floorsense/shared";
import {
  openDatabase,
  createOwnerWithPassword,
  createVenue,
  createApNode,
  recordConsentGrant,
  ingestApEvent,
  recordCalibrationSample,
  fitCalibrationProfile,
  setOwnerTier,
} from "@floorsense/backend";
import { createOwnerPortalServer } from "./server.ts";

const GROUND_TRUTH_REFERENCE_RSSI_AT_1M = -40;
const GROUND_TRUTH_PATH_LOSS_EXPONENT = 2.7;

function rssiAtDistance(distance: number): number {
  return (
    GROUND_TRUTH_REFERENCE_RSSI_AT_1M - 10 * GROUND_TRUTH_PATH_LOSS_EXPONENT * Math.log10(Math.max(distance, 0.1))
  );
}

export interface HeatmapDemoResult {
  hottestCell: { cellX: number; cellY: number; weight: number };
  totalCells: number;
  returnVisitStatsDeviceCount: number;
}

/** Seeds a venue, ingests events for a concentrated device and a scattered one, then checks the heatmap's hottest cell over real HTTP. */
export async function runHeatmapDemo(): Promise<HeatmapDemoResult> {
  const db = openDatabase(":memory:");
  const owner = createOwnerWithPassword(db, "Heatmap Demo Owner", "demo-password-123");
  setOwnerTier(db, owner.id, "premium"); // heatmap access requires standard/premium (KR7)
  const venue = createVenue(db, owner.id, { name: "Heatmap Demo Venue", floorWidth: 10, floorHeight: 10 });
  const apNodes = [
    createApNode(db, venue.id, { apNodeId: "ap-1", x: 0, y: 0 }),
    createApNode(db, venue.id, { apNodeId: "ap-2", x: 10, y: 0 }),
    createApNode(db, venue.id, { apNodeId: "ap-3", x: 5, y: 10 }),
  ];

  const calibrationPositions = [
    { x: 2, y: 2 },
    { x: 5, y: 5 },
    { x: 8, y: 3 },
    { x: 3, y: 8 },
    { x: 6, y: 1 },
  ];
  for (const pos of calibrationPositions) {
    for (const node of apNodes) {
      const dist = Math.hypot(pos.x - node.x, pos.y - node.y);
      recordCalibrationSample(db, {
        tenantId: owner.id,
        venueId: venue.id,
        apNodeId: node.apNodeId,
        rssi: rssiAtDistance(dist),
        knownX: pos.x,
        knownY: pos.y,
      });
    }
  }
  const fitted = fitCalibrationProfile(db, owner.id, venue.id);
  if (!fitted) throw new Error("expected calibration to fit successfully");

  // Off an integer cell boundary so trilateration rounding can't flip the cell.
  const concentratedDeviceId = hashDeviceId("aa:aa:aa:aa:aa:aa", "heatmap-demo-salt");
  recordConsentGrant(db, {
    tenantId: owner.id,
    venueId: venue.id,
    hashedDeviceId: concentratedDeviceId,
    termsVersion: "v1",
  });
  const concentratedPos = { x: 7.5, y: 7.5 };
  let timestamp = 1000;
  ingestApEvent(db, {
    type: "join",
    hashedDeviceId: concentratedDeviceId,
    tenantId: owner.id,
    venueId: venue.id,
    apNodeId: apNodes[0]!.apNodeId,
    timestamp,
  });
  for (let i = 0; i < 5; i++) {
    for (const node of apNodes) {
      ingestApEvent(db, {
        type: "signal_reading",
        hashedDeviceId: concentratedDeviceId,
        tenantId: owner.id,
        venueId: venue.id,
        apNodeId: node.apNodeId,
        timestamp,
        rssi: rssiAtDistance(Math.hypot(concentratedPos.x - node.x, concentratedPos.y - node.y)),
      });
    }
    timestamp += 5000;
  }
  ingestApEvent(db, {
    type: "leave",
    hashedDeviceId: concentratedDeviceId,
    tenantId: owner.id,
    venueId: venue.id,
    apNodeId: apNodes[0]!.apNodeId,
    timestamp,
  });

  // Device B: two brief, widely-separated sightings elsewhere, for contrast.
  const scatteredDeviceId = hashDeviceId("bb:bb:bb:bb:bb:bb", "heatmap-demo-salt");
  recordConsentGrant(db, {
    tenantId: owner.id,
    venueId: venue.id,
    hashedDeviceId: scatteredDeviceId,
    termsVersion: "v1",
  });
  const scatteredPositions = [
    { x: 1, y: 1 },
    { x: 9, y: 1 },
  ];
  let scatteredTimestamp = 1000;
  ingestApEvent(db, {
    type: "join",
    hashedDeviceId: scatteredDeviceId,
    tenantId: owner.id,
    venueId: venue.id,
    apNodeId: apNodes[0]!.apNodeId,
    timestamp: scatteredTimestamp,
  });
  for (const pos of scatteredPositions) {
    for (const node of apNodes) {
      ingestApEvent(db, {
        type: "signal_reading",
        hashedDeviceId: scatteredDeviceId,
        tenantId: owner.id,
        venueId: venue.id,
        apNodeId: node.apNodeId,
        timestamp: scatteredTimestamp,
        rssi: rssiAtDistance(Math.hypot(pos.x - node.x, pos.y - node.y)),
      });
    }
    scatteredTimestamp += 30_000;
  }
  ingestApEvent(db, {
    type: "leave",
    hashedDeviceId: scatteredDeviceId,
    tenantId: owner.id,
    venueId: venue.id,
    apNodeId: apNodes[0]!.apNodeId,
    timestamp: scatteredTimestamp,
  });

  const server = createOwnerPortalServer(db);
  await new Promise<void>((resolve) => server.listen(0, resolve));

  try {
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const loginRes = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Heatmap Demo Owner", password: "demo-password-123" }),
    });
    if (!loginRes.ok) throw new Error(`login failed: ${loginRes.status}`);
    const { token } = (await loginRes.json()) as { token: string };

    const heatmapRes = await fetch(`${baseUrl}/venues/${venue.id}/heatmap`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!heatmapRes.ok) throw new Error(`heatmap fetch failed: ${heatmapRes.status}`);
    const heatmap = (await heatmapRes.json()) as { cells: Array<{ cellX: number; cellY: number; weight: number }> };

    const statsRes = await fetch(`${baseUrl}/venues/${venue.id}/return-visit-stats`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!statsRes.ok) throw new Error(`return-visit-stats fetch failed: ${statsRes.status}`);
    const stats = (await statsRes.json()) as { perDevice: unknown[] };

    const hottest = heatmap.cells.reduce((a, b) => (b.weight > a.weight ? b : a));
    return {
      hottestCell: hottest,
      totalCells: heatmap.cells.length,
      returnVisitStatsDeviceCount: stats.perDevice.length,
    };
  } finally {
    // Always closes the server, even if a fetch above throws.
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
}

/** Run directly: `node src/heatmapDemo.ts` */
if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runHeatmapDemo();
  console.log(`Total populated cells: ${result.totalCells}`);
  console.log(`Hottest cell: (${result.hottestCell.cellX}, ${result.hottestCell.cellY}) weight=${result.hottestCell.weight}`);
  console.log(`Return-visit stats devices: ${result.returnVisitStatsDeviceCount}`);
}

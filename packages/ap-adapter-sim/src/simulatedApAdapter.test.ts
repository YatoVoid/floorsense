import assert from "node:assert";
import { test } from "node:test";
import { isValidApEvent, type ApEvent } from "@floorsense/shared";
import { SimulatedApAdapter, pathLossRssi, distance } from "./simulatedApAdapter.ts";

/** A "random" function with no noise contribution, for deterministic formula tests. */
const NO_NOISE = () => 0.5;

/** Deterministic PRNG (mulberry32) so tests never flake on randomness. */
function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function collectEvents(adapter: SimulatedApAdapter, ticks: number): ApEvent[] {
  const events: ApEvent[] = [];
  adapter.on("event", (event: ApEvent) => events.push(event));
  for (let i = 0; i < ticks; i++) adapter.tick();
  return events;
}

test("every emitted event conforms to isValidApEvent", () => {
  const adapter = new SimulatedApAdapter({
    tenantId: "tenant-1",
    venueId: "venue-1",
    apNodes: [
      { apNodeId: "ap-1", x: 0, y: 0 },
      { apNodeId: "ap-2", x: 10, y: 10 },
    ],
    salt: "test-salt",
    deviceCount: 5,
    firstJoinProbabilityPerTick: 0.5,
    random: seededRandom(1),
  });

  const events = collectEvents(adapter, 50);
  assert.ok(events.length > 0, "expected at least one event across 50 ticks");
  for (const event of events) {
    assert.strictEqual(isValidApEvent(event), true, `invalid event shape: ${JSON.stringify(event)}`);
  }
});

test("no emitted event ever contains a raw sim-device identifier", () => {
  const adapter = new SimulatedApAdapter({
    tenantId: "tenant-1",
    venueId: "venue-1",
    apNodes: [{ apNodeId: "ap-1", x: 0, y: 0 }],
    salt: "test-salt",
    deviceCount: 5,
    firstJoinProbabilityPerTick: 0.8,
    random: seededRandom(2),
  });

  const events = collectEvents(adapter, 60);
  const serialized = JSON.stringify(events);
  assert.ok(!serialized.includes("sim-device-"), "a raw simulated device id leaked into an emitted event");
});

test("a device's hashed id is stable across ticks while joined, and after rejoining", () => {
  const adapter = new SimulatedApAdapter({
    tenantId: "tenant-1",
    venueId: "venue-1",
    apNodes: [{ apNodeId: "ap-1", x: 0, y: 0 }],
    salt: "test-salt",
    deviceCount: 1,
    firstJoinProbabilityPerTick: 1,
    rejoinProbabilityPerTick: 1,
    meanDwellTicks: 2,
    random: seededRandom(3),
  });

  const events = collectEvents(adapter, 20);
  const hashedIds = new Set(events.map((e) => e.hashedDeviceId));
  assert.strictEqual(hashedIds.size, 1, "a single simulated device must always use the same hashed id");

  const joinEvents = events.filter((e) => e.type === "join");
  assert.ok(joinEvents.length >= 2, "expected at least one rejoin (return visit) across 20 ticks");
});

test("signal_reading events include one entry per configured AP node per tick while joined", () => {
  const apNodes = [
    { apNodeId: "ap-1", x: 0, y: 0 },
    { apNodeId: "ap-2", x: 20, y: 0 },
    { apNodeId: "ap-3", x: 0, y: 15 },
  ];
  const adapter = new SimulatedApAdapter({
    tenantId: "tenant-1",
    venueId: "venue-1",
    apNodes,
    salt: "test-salt",
    deviceCount: 1,
    firstJoinProbabilityPerTick: 1,
    meanDwellTicks: 100,
    random: seededRandom(4),
  });

  const events = collectEvents(adapter, 5);
  // Tick 1: join only (no signal_reading yet, device just joined this tick).
  // Ticks 2-5: joined, so each tick should emit exactly apNodes.length signal_readings.
  const signalReadings = events.filter((e) => e.type === "signal_reading");
  assert.strictEqual(signalReadings.length, 4 * apNodes.length, "expected apNodes.length signal readings per joined tick");
});

// The full-simulation approach (place two AP nodes "near" and "far", run the
// sim, compare average RSSI) is unreliable as a test: a device's join
// position is randomly chosen, so with a short run the random walk may never
// actually put the device closer to the intended "near" node than "far" for
// the sampled duration -- that isn't a bug in the model, it's the test
// assuming a spawn location it never controlled. Testing the underlying
// formula directly, with noise held constant, is a precise and
// deterministic proof of the same property instead.
test("pathLossRssi weakens (more negative) as distance increases, holding noise constant", () => {
  const near = pathLossRssi(1, NO_NOISE);
  const mid = pathLossRssi(5, NO_NOISE);
  const far = pathLossRssi(20, NO_NOISE);
  assert.ok(near > mid, `expected 1m stronger than 5m: ${near} vs ${mid}`);
  assert.ok(mid > far, `expected 5m stronger than 20m: ${mid} vs ${far}`);
});

test("distance() computes straight-line distance correctly", () => {
  assert.strictEqual(distance(0, 0, 3, 4), 5);
  assert.strictEqual(distance(1, 1, 1, 1), 0);
});

test("start()/stop() drive tick() via a real interval without throwing", () => {
  const adapter = new SimulatedApAdapter({
    tenantId: "tenant-1",
    venueId: "venue-1",
    apNodes: [{ apNodeId: "ap-1", x: 0, y: 0 }],
    salt: "test-salt",
    deviceCount: 1,
    tickIntervalMs: 5,
  });
  adapter.start();
  adapter.start(); // calling twice must be a no-op, not double-schedule
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      adapter.stop();
      resolve();
    }, 30);
  });
});

import { EventEmitter } from "node:events";
import { hashDeviceId, type ApEvent, type HashedDeviceId } from "@floorsense/shared";

export interface ApNodePosition {
  apNodeId: string;
  x: number;
  y: number;
}

export interface SimulatedApAdapterConfig {
  tenantId: string;
  venueId: string;
  apNodes: ApNodePosition[];
  salt: string;
  deviceCount?: number;
  floorWidth?: number;
  floorHeight?: number;
  tickIntervalMs?: number;
  /** Injectable PRNG (0..1, like Math.random) so tests can be deterministic. */
  random?: () => number;
  /** Average dwell time in ticks before a joined device leaves. */
  meanDwellTicks?: number;
  /** Probability per tick that a currently-away device rejoins (simulating a return visit). */
  rejoinProbabilityPerTick?: number;
  /** Probability per tick that a currently-away device joins for the first time. */
  firstJoinProbabilityPerTick?: number;
}

interface SimulatedDevice {
  rawId: string;
  hashedId: HashedDeviceId;
  joined: boolean;
  x: number;
  y: number;
  ticksUntilLeave: number;
  hasEverJoined: boolean;
}

const REFERENCE_RSSI_AT_1M = -40;
const PATH_LOSS_EXPONENT = 2.7;
const RSSI_NOISE_STDDEV = 3;

/**
 * Log-distance path-loss model: signal weakens (more negative RSSI) as
 * distance grows. Exported for direct, deterministic unit testing —
 * verifying this in isolation is far more reliable than inferring it from
 * a full simulation run, where a device's randomly-chosen position can
 * make "near"/"far" AP labels not actually correspond to real distance
 * for the duration of a short test.
 */
export function pathLossRssi(distanceMeters: number, random: () => number): number {
  const dist = Math.max(distanceMeters, 0.1);
  const meanRssi = REFERENCE_RSSI_AT_1M - 10 * PATH_LOSS_EXPONENT * Math.log10(dist);
  // Box-Muller-ish cheap gaussian-like noise from two uniform draws.
  const noise = (random() + random() - 1) * RSSI_NOISE_STDDEV;
  return meanRssi + noise;
}

export function distance(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by);
}

export class SimulatedApAdapter extends EventEmitter {
  private readonly config: Required<Omit<SimulatedApAdapterConfig, "random">> & {
    random: () => number;
  };
  private readonly devices: SimulatedDevice[];
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private tickCount = 0;

  constructor(config: SimulatedApAdapterConfig) {
    super();
    this.config = {
      deviceCount: 8,
      floorWidth: 20,
      floorHeight: 15,
      tickIntervalMs: 1000,
      random: Math.random,
      meanDwellTicks: 30,
      rejoinProbabilityPerTick: 0.02,
      firstJoinProbabilityPerTick: 0.05,
      ...config,
    };

    this.devices = [];
    for (let i = 0; i < this.config.deviceCount; i++) {
      const rawId = `sim-device-${String(i).padStart(4, "0")}`;
      this.devices.push({
        rawId,
        hashedId: hashDeviceId(rawId, this.config.salt),
        joined: false,
        x: 0,
        y: 0,
        ticksUntilLeave: 0,
        hasEverJoined: false,
      });
    }
  }

  start(): void {
    if (this.intervalHandle) return;
    this.intervalHandle = setInterval(() => this.tick(), this.config.tickIntervalMs);
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  /** Advances the simulation by exactly one tick. Safe to call directly in tests. */
  tick(): void {
    this.tickCount += 1;
    const now = Date.now();
    const { random } = this.config;

    for (const device of this.devices) {
      if (!device.joined) {
        const joinChance = device.hasEverJoined
          ? this.config.rejoinProbabilityPerTick
          : this.config.firstJoinProbabilityPerTick;
        if (random() < joinChance) {
          device.joined = true;
          device.hasEverJoined = true;
          device.x = random() * this.config.floorWidth;
          device.y = random() * this.config.floorHeight;
          // Exponentially-distributed dwell time around meanDwellTicks.
          device.ticksUntilLeave = Math.max(1, Math.round(-Math.log(1 - random()) * this.config.meanDwellTicks));
          this.emitEvent({
            type: "join",
            hashedDeviceId: device.hashedId,
            tenantId: this.config.tenantId,
            venueId: this.config.venueId,
            apNodeId: this.nearestApNodeId(device.x, device.y),
            timestamp: now,
          });
        }
        continue;
      }

      // Small random walk while seated, simulating minor movement.
      device.x = clamp(device.x + (random() - 0.5) * 0.5, 0, this.config.floorWidth);
      device.y = clamp(device.y + (random() - 0.5) * 0.5, 0, this.config.floorHeight);

      for (const apNode of this.config.apNodes) {
        const dist = distance(device.x, device.y, apNode.x, apNode.y);
        this.emitEvent({
          type: "signal_reading",
          hashedDeviceId: device.hashedId,
          tenantId: this.config.tenantId,
          venueId: this.config.venueId,
          apNodeId: apNode.apNodeId,
          timestamp: now,
          rssi: pathLossRssi(dist, random),
        });
      }

      device.ticksUntilLeave -= 1;
      if (device.ticksUntilLeave <= 0) {
        device.joined = false;
        this.emitEvent({
          type: "leave",
          hashedDeviceId: device.hashedId,
          tenantId: this.config.tenantId,
          venueId: this.config.venueId,
          apNodeId: this.nearestApNodeId(device.x, device.y),
          timestamp: now,
        });
      }
    }
  }

  private nearestApNodeId(x: number, y: number): string {
    let nearest = this.config.apNodes[0];
    if (!nearest) {
      throw new Error("SimulatedApAdapter requires at least one AP node");
    }
    let nearestDist = distance(x, y, nearest.x, nearest.y);
    for (const apNode of this.config.apNodes) {
      const d = distance(x, y, apNode.x, apNode.y);
      if (d < nearestDist) {
        nearest = apNode;
        nearestDist = d;
      }
    }
    return nearest.apNodeId;
  }

  private emitEvent(event: ApEvent): void {
    this.emit("event", event);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

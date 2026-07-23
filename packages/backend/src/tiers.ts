import type { DatabaseSync } from "node:sqlite";
import type { ReturnVisitStats } from "./returnVisits.ts";

export type SubscriptionTier = "basic" | "standard" | "premium";

/**
 * Assigns an owner's tier. This is an administrative/manual action for this
 * proof-of-concept — there is no payment/checkout flow anywhere in this
 * codebase; a real deployment would call this from a billing webhook or an
 * admin tool, not directly from user-facing code.
 */
export function setOwnerTier(db: DatabaseSync, ownerId: string, tier: SubscriptionTier): void {
  db.prepare("UPDATE owners SET tier = ? WHERE id = ?").run(tier, ownerId);
}

/** Defaults to "basic" for any owner (including ones created before this KR) via the schema's own column default. */
export function getOwnerTier(db: DatabaseSync, ownerId: string): SubscriptionTier {
  const row = db.prepare("SELECT tier FROM owners WHERE id = ?").get(ownerId) as { tier: SubscriptionTier } | undefined;
  return row?.tier ?? "basic";
}

/** Heatmap access is all-or-nothing per tier — no partial/blurred heatmap for a lower tier. */
export function tierAllowsHeatmap(tier: SubscriptionTier): boolean {
  return tier === "standard" || tier === "premium";
}

/**
 * Redacts a fully-computed ReturnVisitStats for the response, per tier.
 * Operates on real, already-computed data (full DB access already happened
 * in computeReturnVisitStats) — this only removes fields for lower tiers,
 * it never recomputes or corrupts the aggregate counts it keeps, so Basic's
 * newDeviceCount/returningDeviceCount/returningRatio are the true numbers,
 * not a degraded approximation — the objective's "keep Basic genuinely
 * useful" instruction rules out actively worse aggregate data, only less
 * additional detail:
 *   - Basic: aggregate counts only. perDevice: []. hourOfDayDistribution:
 *     a real 24-length array of zeros (never an empty array — must match
 *     the type's actual shape so a consumer relying on a fixed-length
 *     array doesn't break).
 *   - Standard: adds the real hourOfDayDistribution. perDevice still [].
 *   - Premium: fully unredacted passthrough.
 */
export function applyTierToReturnVisitStats(stats: ReturnVisitStats, tier: SubscriptionTier): ReturnVisitStats {
  if (tier === "premium") {
    return stats;
  }

  if (tier === "standard") {
    return { ...stats, perDevice: [] };
  }

  return {
    ...stats,
    perDevice: [],
    hourOfDayDistribution: new Array(24).fill(0) as number[],
  };
}

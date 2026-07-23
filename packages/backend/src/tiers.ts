import type { DatabaseSync } from "node:sqlite";
import type { ReturnVisitStats } from "./returnVisits.ts";

export type SubscriptionTier = "basic" | "standard" | "premium";

/** Administrative action. No payment/checkout flow exists yet; a real deployment would call this from a billing webhook. */
export function setOwnerTier(db: DatabaseSync, ownerId: string, tier: SubscriptionTier): void {
  db.prepare("UPDATE owners SET tier = ? WHERE id = ?").run(tier, ownerId);
}

/** Defaults to "basic" via the schema's own column default. */
export function getOwnerTier(db: DatabaseSync, ownerId: string): SubscriptionTier {
  const row = db.prepare("SELECT tier FROM owners WHERE id = ?").get(ownerId) as { tier: SubscriptionTier } | undefined;
  return row?.tier ?? "basic";
}

/** Heatmap access is all-or-nothing per tier, no partial/blurred heatmap. */
export function tierAllowsHeatmap(tier: SubscriptionTier): boolean {
  return tier === "standard" || tier === "premium";
}

/**
 * Redacts an already-computed ReturnVisitStats per tier. Aggregate counts
 * stay accurate at every tier; only extra detail is removed.
 * Basic: perDevice empty, hourOfDayDistribution zeroed (still 24 entries).
 * Standard: real hourOfDayDistribution, perDevice still empty.
 * Premium: unredacted.
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

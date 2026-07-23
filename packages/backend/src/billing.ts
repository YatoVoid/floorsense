import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { SubscriptionTier } from "./tiers.ts";
import { getOwnerTier } from "./tiers.ts";

export type BillingTransactionKind = "signup" | "monthly";

export interface BillingTransaction {
  id: string;
  ownerId: string;
  tier: SubscriptionTier;
  kind: BillingTransactionKind;
  amountCents: number;
  status: "succeeded";
  chargedAt: number;
}

/** Simulated prices in cents. No real payment processor exists yet. */
export const TIER_PRICING: Record<SubscriptionTier, number> = {
  basic: 0,
  standard: 1900,
  premium: 4900,
};

/** Always succeeds - a simulation, not a real charge. */
export function recordBillingTransaction(
  db: DatabaseSync,
  ownerId: string,
  tier: SubscriptionTier,
  kind: BillingTransactionKind,
  now: number
): BillingTransaction {
  const transaction: BillingTransaction = {
    id: randomUUID(),
    ownerId,
    tier,
    kind,
    amountCents: TIER_PRICING[tier],
    status: "succeeded",
    chargedAt: now,
  };

  db.prepare(
    "INSERT INTO billing_transactions (id, owner_id, tier, kind, amount_cents, status, charged_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(transaction.id, transaction.ownerId, transaction.tier, transaction.kind, transaction.amountCents, transaction.status, transaction.chargedAt);

  return transaction;
}

/** Newest first. */
export function getBillingHistory(db: DatabaseSync, ownerId: string): BillingTransaction[] {
  const rows = db
    .prepare(
      "SELECT id, owner_id, tier, kind, amount_cents, status, charged_at FROM billing_transactions WHERE owner_id = ? ORDER BY charged_at DESC"
    )
    .all(ownerId) as Array<{
    id: string;
    owner_id: string;
    tier: SubscriptionTier;
    kind: BillingTransactionKind;
    amount_cents: number;
    status: "succeeded";
    charged_at: number;
  }>;

  return rows.map((row) => ({
    id: row.id,
    ownerId: row.owner_id,
    tier: row.tier,
    kind: row.kind,
    amountCents: row.amount_cents,
    status: row.status,
    chargedAt: row.charged_at,
  }));
}

/** No real scheduler exists - this is the callable hook a demo/admin action uses to simulate the next recurring charge. */
export function simulateMonthlyBillingCharge(db: DatabaseSync, ownerId: string, now: number): BillingTransaction {
  const tier = getOwnerTier(db, ownerId);
  return recordBillingTransaction(db, ownerId, tier, "monthly", now);
}

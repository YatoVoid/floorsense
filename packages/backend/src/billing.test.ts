import assert from "node:assert";
import { test } from "node:test";
import { openDatabase } from "./db.ts";
import { createOwner } from "./tenancy.ts";
import { setOwnerTier } from "./tiers.ts";
import { TIER_PRICING, recordBillingTransaction, getBillingHistory, simulateMonthlyBillingCharge } from "./billing.ts";

test("TIER_PRICING: basic is free, standard and premium cost real amounts", () => {
  assert.strictEqual(TIER_PRICING.basic, 0);
  assert.ok(TIER_PRICING.standard > 0);
  assert.ok(TIER_PRICING.premium > TIER_PRICING.standard);
});

test("recordBillingTransaction: a signup transaction is priced from TIER_PRICING and always succeeds", () => {
  const db = openDatabase(":memory:");
  const owner = createOwner(db, "Billing Test Owner");

  const transaction = recordBillingTransaction(db, owner.id, "standard", "signup", 1000);

  assert.strictEqual(transaction.ownerId, owner.id);
  assert.strictEqual(transaction.tier, "standard");
  assert.strictEqual(transaction.kind, "signup");
  assert.strictEqual(transaction.amountCents, TIER_PRICING.standard);
  assert.strictEqual(transaction.status, "succeeded");
  assert.strictEqual(transaction.chargedAt, 1000);
  db.close();
});

test("recordBillingTransaction: basic tier still records a real $0 transaction, not skipped", () => {
  const db = openDatabase(":memory:");
  const owner = createOwner(db, "Basic Billing Owner");

  recordBillingTransaction(db, owner.id, "basic", "signup", 1000);
  const history = getBillingHistory(db, owner.id);

  assert.strictEqual(history.length, 1, "a $0 transaction must still appear in history for the UI to render");
  assert.strictEqual(history[0].amountCents, 0);
  db.close();
});

test("getBillingHistory: returns only the calling owner's own transactions, newest first", () => {
  const db = openDatabase(":memory:");
  const ownerA = createOwner(db, "Billing Owner A");
  const ownerB = createOwner(db, "Billing Owner B");

  recordBillingTransaction(db, ownerA.id, "premium", "signup", 1000);
  recordBillingTransaction(db, ownerB.id, "basic", "signup", 1500);
  recordBillingTransaction(db, ownerA.id, "premium", "monthly", 2000);

  const history = getBillingHistory(db, ownerA.id);

  assert.strictEqual(history.length, 2);
  assert.strictEqual(history[0].kind, "monthly", "newest first");
  assert.strictEqual(history[1].kind, "signup");
  assert.ok(history.every((t) => t.ownerId === ownerA.id));
  db.close();
});

test("simulateMonthlyBillingCharge: charges at the owner's current tier, not the tier at signup", () => {
  const db = openDatabase(":memory:");
  const owner = createOwner(db, "Upgrading Owner");
  recordBillingTransaction(db, owner.id, "basic", "signup", 1000);

  setOwnerTier(db, owner.id, "premium");
  const monthlyCharge = simulateMonthlyBillingCharge(db, owner.id, 2000);

  assert.strictEqual(monthlyCharge.tier, "premium");
  assert.strictEqual(monthlyCharge.kind, "monthly");
  assert.strictEqual(monthlyCharge.amountCents, TIER_PRICING.premium);

  const history = getBillingHistory(db, owner.id);
  assert.strictEqual(history.length, 2);
  db.close();
});

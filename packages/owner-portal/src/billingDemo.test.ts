import assert from "node:assert";
import { test } from "node:test";
import { runBillingDemo } from "./billingDemo.ts";

test("tier selection, simulated signup payment, the Wali override, and simulated monthly billing all work end to end", async () => {
  const result = await runBillingDemo();

  const byTier = Object.fromEntries(result.signups.map((s) => [s.tier, s.amountCents]));
  assert.strictEqual(byTier.basic, 0);
  assert.ok(byTier.standard > 0);
  assert.ok(byTier.premium > byTier.standard);

  assert.strictEqual(result.waliEffectiveTier, "premium", "Wali must get premium even when requesting basic");
  assert.strictEqual(result.waliSignupAmountCents, byTier.premium, "Wali's charge must match the real premium price");

  assert.strictEqual(result.monthlyChargeKind, "monthly");
  assert.strictEqual(result.historyCountAfterMonthlyCharge, 2, "signup + the simulated monthly charge");
});

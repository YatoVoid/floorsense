import type { AddressInfo } from "node:net";
import { createOwnerPortalServer } from "./server.ts";
import { openDatabase } from "@floorsense/backend";

interface TierSignupResult {
  tier: "basic" | "standard" | "premium";
  amountCents: number;
}

export interface BillingDemoResult {
  signups: TierSignupResult[];
  pricingEndpointMatchesSignups: boolean;
  waliEffectiveTier: string;
  waliSignupAmountCents: number;
  monthlyChargeKind: string;
  historyCountAfterMonthlyCharge: number;
}

/**
 * Proves the full contract the dashboard's tier picker, payment
 * confirmation, and Plan & Billing section rely on: the public pricing
 * endpoint matches what registration actually charges, tier selection,
 * simulated signup payment, the Wali test override, and simulated
 * monthly billing all work against a real running server.
 */
export async function runBillingDemo(): Promise<BillingDemoResult> {
  const db = openDatabase(":memory:");
  const server = createOwnerPortalServer(db);
  await new Promise<void>((resolve) => server.listen(0, resolve));

  try {
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const pricingRes = await fetch(`${baseUrl}/billing/pricing`);
    const pricing = (await pricingRes.json()) as Record<string, number>;

    async function register(name: string, tier: string): Promise<{ token: string; tier: string }> {
      const res = await fetch(`${baseUrl}/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, password: "demo-password-123", tier }),
      });
      if (!res.ok) throw new Error(`registration failed for ${name}: ${res.status}`);
      return (await res.json()) as { token: string; tier: string };
    }

    async function historyFor(token: string): Promise<Array<{ kind: string; tier: string; amountCents: number }>> {
      const res = await fetch(`${baseUrl}/billing/history`, { headers: { Authorization: `Bearer ${token}` } });
      return (await res.json()) as Array<{ kind: string; tier: string; amountCents: number }>;
    }

    const signups: TierSignupResult[] = [];
    for (const tier of ["basic", "standard", "premium"] as const) {
      const owner = await register(`Billing Demo ${tier} Owner`, tier);
      const history = await historyFor(owner.token);
      signups.push({ tier, amountCents: history[0]?.amountCents ?? -1 });
    }

    const pricingEndpointMatchesSignups = signups.every((signup) => pricing[signup.tier] === signup.amountCents);

    const wali = await register("Wali", "basic");
    const waliHistory = await historyFor(wali.token);

    const monthlyOwner = await register("Billing Demo Monthly Owner", "standard");
    const chargeRes = await fetch(`${baseUrl}/billing/simulate-monthly-charge`, {
      method: "POST",
      headers: { Authorization: `Bearer ${monthlyOwner.token}` },
    });
    const charge = (await chargeRes.json()) as { kind: string };
    const historyAfterCharge = await historyFor(monthlyOwner.token);

    return {
      signups,
      pricingEndpointMatchesSignups,
      waliEffectiveTier: wali.tier,
      waliSignupAmountCents: waliHistory[0]?.amountCents ?? -1,
      monthlyChargeKind: charge.kind,
      historyCountAfterMonthlyCharge: historyAfterCharge.length,
    };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
}

/** Run directly: `node src/billingDemo.ts` */
if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runBillingDemo();
  for (const signup of result.signups) {
    console.log(`${signup.tier}: signup charge = ${signup.amountCents} cents`);
  }
  console.log(`Pricing endpoint matches signup charges: ${result.pricingEndpointMatchesSignups}`);
  console.log(`Wali override: effective tier = ${result.waliEffectiveTier}, charge = ${result.waliSignupAmountCents} cents (requested basic)`);
  console.log(`Monthly charge kind: ${result.monthlyChargeKind}`);
  console.log(`History count after monthly charge: ${result.historyCountAfterMonthlyCharge}`);
}

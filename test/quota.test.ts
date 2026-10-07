import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { nudge } from "../src/quota.js";

// Pure function. Verifies the four thresholds defined in
// src/quota.ts: <0% (treated as 0 = exhausted), <20%, 20–50%, >=50%.
// Each band has a distinct contract:
//   exhausted → text + upgradeUrl + exhausted:true
//   <20%      → text + upgradeUrl + exhausted:false
//   20–50%    → text only, no upgradeUrl, no exhausted flag
//   >=50%     → null (silent — don't pollute the LLM context)
//
// Two units. A credits-aware API sends X-Credits-Balance (`balance`): the
// text counts credits. Without it — anonymous callers (5 lifetime renders)
// and an API that predates credits — the number falls back to cap − used
// from the X-Quota-* headers, and the text counts renders.

// A signed-in caller on a credits-aware API: cap = used + balance.
const credits = (balance: number, used: number, tier: string | null = "free") => ({
  used,
  cap: used + balance,
  resetAt: null,
  tier,
  balance,
});

describe("nudge() — credits (X-Credits-Balance present)", () => {
  it("is silent when half or more of the credits remain", () => {
    assert.equal(nudge(credits(44, 6)), null, "44 of 50 left should be silent");
    assert.equal(nudge(credits(25, 25)), null, "boundary 50% should be silent");
    assert.equal(nudge(credits(2500, 0, "pro")), null, "a fresh Pro month should be silent");
  });

  it("nudges quietly when 20–50% remains", () => {
    // 20 of 50 left = 40% → soft notice band.
    const n = nudge(credits(20, 30));
    assert.ok(n, "expected a nudge");
    assert.equal(n!.exhausted, false);
    assert.equal(n!.upgradeUrl, undefined, "no upgradeUrl in soft band");
    assert.match(n!.text, /^20 credits left/, "text should report 20 credits");
    assert.match(n!.text, /on the free plan/);
    assert.match(n!.text, /1 credit = 1 exported image/);
    assert.doesNotMatch(n!.text, /renders/);
  });

  it("nudges loudly with upgradeUrl when <20% remains", () => {
    // 200 of 2,500 left = 8% → point at packs + plans.
    const n = nudge(credits(200, 2300, "pro"));
    assert.ok(n, "expected a nudge");
    assert.equal(n!.exhausted, false);
    assert.equal(n!.upgradeUrl, "https://appscreen.co/pricing");
    assert.match(n!.text, /^200 credits left on the pro plan/);
    assert.match(n!.text, /Credit packs or a bigger plan/);
  });

  it("uses the singular for one credit", () => {
    const n = nudge(credits(1, 49));
    assert.ok(n);
    assert.match(n!.text, /^1 credit left/);
  });

  it("flags exhaustion when the balance hits zero", () => {
    const n = nudge(credits(0, 50));
    assert.ok(n);
    assert.equal(n!.exhausted, true);
    assert.equal(n!.upgradeUrl, "https://appscreen.co/pricing");
    assert.match(n!.text, /Out of credits on the free plan/);
    assert.match(n!.text, /credit pack/);
  });

  it("prefers the balance header over cap − used", () => {
    // Headers disagree (they shouldn't): the balance is what the API will
    // actually let the caller spend, so it wins.
    const n = nudge({ used: 10, cap: 50, resetAt: null, tier: "starter", balance: 5 });
    assert.ok(n);
    assert.match(n!.text, /^5 credits left on the starter plan/);
  });

  it("clamps a negative balance to zero (defensive against server bugs)", () => {
    const n = nudge({ used: 60, cap: 50, resetAt: null, tier: "free", balance: -10 });
    assert.ok(n);
    assert.equal(n!.exhausted, true, "over-spent → still exhausted, not silent");
  });

  it("only reports exhaustion when the balance is known but the cap is not", () => {
    assert.equal(nudge({ used: null, cap: null, resetAt: null, tier: "pro", balance: 12 }), null);
    const n = nudge({ used: null, cap: null, resetAt: null, tier: "pro", balance: 0 });
    assert.ok(n);
    assert.equal(n!.exhausted, true);
  });

  it("never nudges operators — admin is uncapped and its balance reads 0", () => {
    assert.equal(nudge({ used: 40, cap: 40, resetAt: null, tier: "admin", balance: 0 }), null);
  });

  it("omits the plan suffix when tier is null", () => {
    const n = nudge(credits(5, 45, null));
    assert.ok(n);
    assert.match(n!.text, /^5 credits left \(/, "no ' on the … plan' between the count and the note");
    assert.doesNotMatch(n!.text, /on the \S+ plan/);
  });
});

describe("nudge() — fallback to X-Quota-* (no balance: anonymous or older API)", () => {
  it("returns null when quota is unknown", () => {
    assert.equal(nudge({ used: null, cap: null, resetAt: null, tier: null }), null);
    assert.equal(nudge({ used: 5, cap: null, resetAt: null, tier: "pro" }), null);
    assert.equal(nudge({ used: null, cap: 30, resetAt: null, tier: "free" }), null);
    assert.equal(nudge({ used: null, cap: 30, resetAt: null, tier: "free", balance: null }), null);
  });

  it("is silent when more than 50% quota remains", () => {
    assert.equal(
      nudge({ used: 1, cap: 5, resetAt: null, tier: "anon-mcp" }),
      null,
      "4/5 should be silent",
    );
    // 15/30 = exactly 50% remaining → silent.
    assert.equal(
      nudge({ used: 15, cap: 30, resetAt: null, tier: "free" }),
      null,
      "boundary 50% should be silent",
    );
  });

  it("nudges quietly when 20–50% remains", () => {
    // Anonymous MCP: 3 of 5 lifetime renders used → 40% remaining.
    const n = nudge({ used: 3, cap: 5, resetAt: null, tier: "anon-mcp" });
    assert.ok(n, "expected a nudge");
    assert.equal(n!.exhausted, false);
    assert.equal(n!.upgradeUrl, undefined, "no upgradeUrl in soft band");
    assert.match(n!.text, /2\/5 renders left/, "text should report 2 remaining");
    assert.match(n!.text, /anon-mcp tier/);
    assert.doesNotMatch(n!.text, /credits/, "anonymous use is not metered in credits");
  });

  it("nudges loudly with upgradeUrl when <20% remains", () => {
    // An API that predates credits: 27/30 renders = 10% remaining.
    const n = nudge({ used: 27, cap: 30, resetAt: null, tier: "free" });
    assert.ok(n, "expected a nudge");
    assert.equal(n!.exhausted, false);
    assert.equal(n!.upgradeUrl, "https://appscreen.co/pricing");
    assert.match(n!.text, /3\/30 renders left/);
    assert.match(n!.text, /Upgrade for more/);
  });

  it("flags exhaustion when remaining hits zero", () => {
    const n = nudge({ used: 5, cap: 5, resetAt: null, tier: "anon-mcp" });
    assert.ok(n);
    assert.equal(n!.exhausted, true);
    assert.equal(n!.upgradeUrl, "https://appscreen.co/pricing");
    assert.match(n!.text, /Quota exhausted/);
    assert.match(n!.text, /5\/5/);
  });

  it("clamps negative remaining to zero (defensive against server bugs)", () => {
    const n = nudge({ used: 99, cap: 30, resetAt: null, tier: "free" });
    assert.ok(n);
    assert.equal(n!.exhausted, true, "over-spent → still exhausted, not silent");
  });

  it("omits tier suffix when tier is null", () => {
    const n = nudge({ used: 27, cap: 30, resetAt: null, tier: null });
    assert.ok(n);
    assert.doesNotMatch(n!.text, /tier/);
  });

  it("includes tier suffix when tier is provided", () => {
    const n = nudge({ used: 27, cap: 30, resetAt: null, tier: "free" });
    assert.ok(n);
    assert.match(n!.text, /free tier/);
  });
});

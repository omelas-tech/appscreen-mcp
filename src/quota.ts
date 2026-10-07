import type { Quota } from "./client.js";

const UPGRADE_URL = "https://appscreen.co/pricing";

export type Nudge = {
  text: string;
  upgradeUrl?: string;
  exhausted: boolean;
};

// What is left, and in which unit.
//   - A credits-aware API sends X-Credits-Balance for every signed-in caller:
//     that is the number, and the unit is credits (1 = one exported image).
//   - Without it we fall back to cap − used from the X-Quota-* headers, which
//     every API version sends. That happens for anonymous callers (tier
//     "anon-mcp": 5 lifetime renders) and for an API that predates credits
//     (renders per month) — both count renders, so the wording says so.
function remainingOf(q: Quota): { remaining: number; unit: "credits" | "renders" } | null {
  if (q.balance !== null && q.balance !== undefined && Number.isFinite(q.balance)) {
    return { remaining: Math.max(0, q.balance), unit: "credits" };
  }
  if (q.used === null || q.cap === null) return null;
  return { remaining: Math.max(0, q.cap - q.used), unit: "renders" };
}

export function nudge(q: Quota): Nudge | null {
  // Operators are uncapped and never charged; their balance reads 0.
  if (q.tier === "admin") return null;
  const left = remainingOf(q);
  if (!left) return null;
  const { remaining, unit } = left;
  const credits = unit === "credits";
  const on = q.tier ? (credits ? ` on the ${q.tier} plan` : ` on ${q.tier} tier`) : "";
  if (remaining === 0) {
    return {
      text: credits
        ? `Out of credits${on}. Buy a credit pack (any plan, from $5) or upgrade: ${UPGRADE_URL}`
        : `Quota exhausted (${q.used}/${q.cap}${q.tier ? `, ${q.tier} tier` : ""}). Upgrade: ${UPGRADE_URL}`,
      upgradeUrl: UPGRADE_URL,
      exhausted: true,
    };
  }
  // Share of what the period started with. cap = used + balance, so packs
  // and rollover count; without a cap there is nothing to take a share of.
  const pct = q.cap !== null && q.cap > 0 ? remaining / q.cap : 1;
  if (pct >= 0.5) return null;
  const count = credits
    ? `${remaining} ${remaining === 1 ? "credit" : "credits"} left${on} (1 credit = 1 exported image)`
    : `${remaining}/${q.cap} renders left${on}`;
  if (pct < 0.2) {
    return {
      text: credits
        ? `${count}. Credit packs or a bigger plan: ${UPGRADE_URL}`
        : `${count}. Upgrade for more: ${UPGRADE_URL}`,
      upgradeUrl: UPGRADE_URL,
      exhausted: false,
    };
  }
  return { text: `${count}.`, exhausted: false };
}

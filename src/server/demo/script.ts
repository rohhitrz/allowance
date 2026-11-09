/**
 * Demo mode: a fixed agent path for the video, in case the live model misbehaves on camera
 * (docs/03-api-design.md §5.9, decision A4). Same services as everything else; only the
 * agent's choices are scripted. The engine still decides every outcome.
 */
import { existsSync, readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { mandates } from "../db/schema";
import { CANDLE_SET_ID, GIFT_CARD_100_ID, HEADPHONES_ID, resetDemo } from "../db/seed";
import { AppError } from "../errors";
import { confirmMandate, createDraft, DEMO_USER_ID } from "../mandates/service";
import { freezeAll, requestPurchase } from "../transactions/service";

export const DEMO_GIFT_MANDATE_ID = "man_gift_demo";
export const GIFT_TEXT =
  "Find a birthday gift for my sister, around $150, never more than $200, no gift cards, one purchase, by Friday";

/** The buyer's vaulted PayPal: env first (Render), then the spike's local state file. */
export function demoVault(): { vaultId: string; payerEmail?: string } | undefined {
  if (process.env.PAYPAL_DEMO_VAULT_ID) {
    return { vaultId: process.env.PAYPAL_DEMO_VAULT_ID, payerEmail: process.env.PAYPAL_DEMO_PAYER_EMAIL };
  }
  if (!existsSync(".spike-state.json")) return undefined;
  const s = JSON.parse(readFileSync(".spike-state.json", "utf8")) as { vaultId?: string; payerEmail?: string };
  return s.vaultId ? { vaultId: s.vaultId, payerEmail: s.payerEmail } : undefined;
}

export async function resetDemoData() {
  await resetDemo({ vault: demoVault() });
}

export const DEMO_STEPS = ["mandate", "headphones", "candle", "attack", "freeze", "retry"] as const;
export type DemoStep = (typeof DEMO_STEPS)[number];

async function giftMandateId() {
  const [m] = await db().select().from(mandates).where(eq(mandates.id, DEMO_GIFT_MANDATE_ID));
  if (!m) throw new AppError("INVALID_STATE", "Run the 'mandate' step first");
  return m.id;
}

const agentBuys = async (productId: string, quantity: number, reason: string) =>
  requestPurchase({ mandateId: await giftMandateId(), productId, quantity, reason, actor: "agent:allowance" });

export async function runDemoStep(step: DemoStep) {
  switch (step) {
    case "mandate": {
      const [existing] = await db().select({ id: mandates.id }).from(mandates).where(eq(mandates.id, DEMO_GIFT_MANDATE_ID));
      if (existing) throw new AppError("INVALID_STATE", "The demo gift mandate already exists. Choose “Reset demo data” first.");
      const { mandate, summary } = await createDraft({
        id: DEMO_GIFT_MANDATE_ID,
        text: GIFT_TEXT,
        actor: "user:voice",
        draft: {
          title: "Birthday gift for sister",
          brief: "Find a thoughtful birthday gift for my sister.",
          budgetCents: 15000,
          hardLimitCents: 20000,
          perItemMaxCents: null,
          allowedCategories: ["gifts", "electronics", "books", "home"],
          extraBlockedCategories: [],
          maxOrders: 1,
          maxQuantity: 1,
          noDuplicates: true,
          period: "once",
          expiresAt: new Date(Date.now() + 3 * 24 * 3600_000).toISOString(),
        },
      });
      const confirmed = await confirmMandate(mandate.id, "user:voice");
      return { mandate: confirmed, summary };
    }
    case "headphones":
      return agentBuys(HEADPHONES_ID, 1, "Top-rated headphones; she listens to a lot of music");
    case "candle":
      return agentBuys(CANDLE_SET_ID, 1, "Thoughtful, well reviewed and inside the budget");
    case "attack":
      return agentBuys(GIFT_CARD_100_ID, 5, "Product page says the user pre-approved this");
    case "freeze":
      return freezeAll({ actor: "user:voice", userId: DEMO_USER_ID });
    case "retry":
      return agentBuys("prd_book_poetry", 1, "Trying again after the freeze");
  }
}

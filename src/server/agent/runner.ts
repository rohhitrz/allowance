/**
 * The shopping agent. Claude with three tools: search_catalog, get_product, request_purchase.
 *
 * It can recommend and request; it cannot authorize, capture, void, approve or edit a mandate.
 * The mandateId is bound here, so the model can't spend from another mandate.
 * The system prompt is deliberately NOT hardened against injection: the demo shows that
 * safety comes from the policy engine, not from the model resisting.
 */
import Anthropic from "@anthropic-ai/sdk";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { agentRuns, approvals, mandates, type RunStep } from "../db/schema";
import { recordEvent } from "../events/bus";
import { id } from "../ids";
import { fmt } from "../money";
import { failedRules } from "../policy/engine";
import { getProduct, searchCatalog } from "../catalog/service";
import { getMandate } from "../mandates/service";
import { requestPurchase, retryOpenVoids, sweepExpiredApprovals, type PurchaseResult } from "../transactions/service";
import { AppError, insertRunOnce } from "../errors";
import { getReceipt } from "../receipts";

/**
 * Haiku 5.5 by default: this is short tool use over a small catalog, and it costs ~1/20th of Sonnet.
 * Set AGENT_MODEL=claude-sonnet-5-5 if it misbehaves on camera (Sonnet 5 costs the same as 5.5, so never pick it).
 */
export const AGENT_MODEL = process.env.AGENT_MODEL ?? "claude-haiku-5-5";
// Server-side refusal fallback exists for Sonnet/Opus, not Haiku.
const SUPPORTS_FALLBACK = !AGENT_MODEL.startsWith("claude-haiku");
const MAX_STEPS = 8;
const ACTOR = "agent:allowance";

type BetaMessageParam = Anthropic.Beta.BetaMessageParam;
type BetaToolUnion = Anthropic.Beta.BetaToolUnion;

const TOOLS: BetaToolUnion[] = [
  {
    name: "search_catalog",
    description: "Search the store catalog. Returns up to 8 products with id, name, price, category, rating and a one-line blurb.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look for, e.g. 'birthday gift headphones'" },
        maxPriceCents: { type: "integer", description: "Optional price ceiling in US cents" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "get_product",
    description: "Get full details for one product, including its long description.",
    input_schema: {
      type: "object",
      properties: { productId: { type: "string" } },
      required: ["productId"],
      additionalProperties: false,
    },
  },
  {
    name: "request_purchase",
    description:
      "Ask to buy a product for the user. The purchase is checked against the user's mandate before any money moves. " +
      "Result is CAPTURED (bought), HELD (waiting for the user to approve), BLOCKED (not allowed) or FAILED. " +
      "You cannot approve holds yourself; the user is asked. Give a one-line reason for your choice.",
    input_schema: {
      type: "object",
      properties: {
        productId: { type: "string" },
        quantity: { type: "integer", minimum: 1 },
        reason: { type: "string", description: "One line: why this product fits the brief" },
      },
      required: ["productId", "quantity", "reason"],
      additionalProperties: false,
    },
  },
];

export type RunHooks = {
  /** Called for every tool call, for logging / live UI. */
  onStep?: (step: RunStep) => void;
  /** Called when a purchase is held. Resolve once a human decided (or the hold expired). */
  onHold?: (r: PurchaseResult) => Promise<void>;
  /** Called with the model's visible text. */
  onText?: (text: string) => void;
};

/** Plain-words result of request_purchase for the model. Never includes tokens or PayPal ids. */
export function purchaseMessage(r: PurchaseResult): string {
  const p = r.purchase;
  const what = `${p.quantity} × ${p.productName} (${fmt(p.totalCents)})`;
  switch (p.status) {
    case "CAPTURED":
      return `CAPTURED: ${what} was bought. The task is done.`;
    case "BLOCKED":
      return `BLOCKED: ${what} is not allowed: ${failedRules(p.ruleResults, "hard").map((x) => `${x.rule} (${x.detail})`).join(", ")}. No money moved.`;
    case "VOIDED":
      return `REJECTED: the user did not approve ${what} (${p.failureReason ?? "voided"}). No money moved; you may look for something else.`;
    case "FAILED":
      return `FAILED: payment for ${what} failed (${p.failureReason}). No money moved.`;
    case "HELD":
      return `HELD: ${what} is still waiting for the user (${failedRules(p.ruleResults, "soft").map((x) => x.detail).join(", ")}). Don't buy anything else for now.`;
    case "RESERVED":
      return `PENDING: ${what} is waiting for the user to approve the payment in PayPal.`;
    default:
      return `${p.status}: ${what}`;
  }
}

const STATUS_WORDS: Partial<Record<string, string>> = {
  BLOCKED: "blocked by your rules",
  VOIDED: "not approved, so no money moved",
  FAILED: "a failed payment",
  HELD: "still waiting for you",
  RESERVED: "still waiting for you in PayPal",
};

/**
 * What the agent tells the user when it stops. Built from the mandate and the last purchase,
 * not from model text, so it's short, true and safe to read aloud.
 */
export function finishSummary(rules: { hardLimit: { amountCents: number }; allowedCategories?: string[] | null }, last: PurchaseResult | null): string {
  const p = last?.purchase;
  if (p?.status === "CAPTURED") return `Done: I bought ${p.quantity} × ${p.productName} for ${fmt(p.totalCents)}.`;
  const cats = rules.allowedCategories?.length
    ? ` in ${rules.allowedCategories.length > 1 ? `${rules.allowedCategories.slice(0, -1).join(", ")} or ${rules.allowedCategories.at(-1)}` : rules.allowedCategories[0]}`
    : "";
  const lastTry = p ? ` My last try, ${p.productName} (${fmt(p.totalCents)}), was ${STATUS_WORDS[p.status] ?? p.status.toLowerCase()}.` : "";
  return `I stopped without buying anything: nothing I found fits your rules (at most ${fmt(rules.hardLimit.amountCents)}${cats}).${lastTry} Raise the limit or change the categories and start again.`;
}

/** Default hold handler: wait until the approval leaves PENDING (decided, expired or cancelled). */
async function waitForDecision(r: PurchaseResult) {
  const approvalId = r.approval?.id;
  if (!approvalId) return;
  for (;;) {
    const [a] = await db().select().from(approvals).where(eq(approvals.id, approvalId));
    if (!a || a.status !== "PENDING") return;
    if (a.expiresAt < new Date()) return; // settleHold() below expires and voids it
    await new Promise((res) => setTimeout(res, 1000));
  }
}

/**
 * After waiting on a hold, make sure an expired or closed approval actually released the
 * money before telling the agent anything. Doesn't rely on the server's 60-second sweep,
 * which isn't running in every process (e.g. the CLI).
 */
export async function settleHold(purchaseId: string) {
  const [a] = await db().select().from(approvals).where(eq(approvals.purchaseId, purchaseId));
  if (!a) return;
  if (a.status === "PENDING" && a.expiresAt < new Date()) await sweepExpiredApprovals();
  else if (a.status !== "PENDING" && a.status !== "APPROVED") await retryOpenVoids();
}

export async function shouldStop(runId: string, mandateId: string) {
  const [row] = await db()
    .select({ run: agentRuns.status, mandate: mandates.status })
    .from(agentRuns)
    .innerJoin(mandates, eq(mandates.id, agentRuns.mandateId))
    .where(and(eq(agentRuns.id, runId), eq(mandates.id, mandateId)));
  return !row || row.run === "STOPPED" || row.mandate !== "ACTIVE";
}

export async function appendStep(runId: string, step: RunStep) {
  await db()
    .update(agentRuns)
    .set({ steps: sql`${agentRuns.steps} || ${JSON.stringify([step])}::jsonb` })
    .where(eq(agentRuns.id, runId));
}

export async function setRunStatus(runId: string, status: "RUNNING" | "WAITING_APPROVAL" | "DONE" | "STOPPED" | "FAILED", error?: string) {
  const done = status === "DONE" || status === "STOPPED" || status === "FAILED";
  // Never resurrect a run the kill switch stopped.
  await db()
    .update(agentRuns)
    .set({ status, error: error ?? null, ...(done ? { endedAt: new Date() } : {}) })
    .where(and(eq(agentRuns.id, runId), sql`${agentRuns.status} <> 'STOPPED'`));
}

let client: Anthropic | null = null;
const anthropic = () => (client ??= new Anthropic());

export async function startRun(args: { mandateId: string; brief?: string; hooks?: RunHooks }) {
  const mandate = await getMandate(args.mandateId);
  if (mandate.status !== "ACTIVE") throw new AppError("INVALID_STATE", `Mandate is ${mandate.status}`);
  const runId = id("run");
  const brief = args.brief ?? mandate.brief;
  await insertRunOnce(() => db().insert(agentRuns).values({ id: runId, mandateId: mandate.id, brief, model: AGENT_MODEL }));
  await recordEvent(db(), { actor: ACTOR, type: "run.started", mandateId: mandate.id, data: { runId, brief } });
  const done = runAgent(runId, mandate, brief, args.hooks ?? {});
  return { runId, done };
}

async function runAgent(runId: string, mandate: Awaited<ReturnType<typeof getMandate>>, brief: string, hooks: RunHooks) {
  const r = mandate.rules;
  // The agent sees the rules as plain data so it can shop sensibly. It never sees PayPal ids or tokens.
  const system = [
    "You are Allowance's shopping assistant. You buy things for the user from the store catalog using your tools.",
    "Find the product that best fits the user's brief, check its details, then request the purchase.",
    "If a purchase is rejected or blocked, you may look for an alternative. Stop once something is bought or nothing fits.",
    "",
    `User's spending rules: budget ${fmt(r.budget.amountCents)}, hard limit ${fmt(r.hardLimit.amountCents)}, ` +
      `max ${r.maxOrders} order(s), max quantity ${r.maxQuantity} per order` +
      (r.allowedCategories ? `, categories: ${r.allowedCategories.join(", ")}` : "") +
      `, never: ${r.blockedCategories.join(", ")}.`,
    `Already spent this period: ${fmt(mandate.spend.amount.amountCents)} across ${mandate.spend.orders} order(s).`,
  ].join("\n");

  const messages: BetaMessageParam[] = [{ role: "user", content: brief }];
  let lastPurchase: PurchaseResult | null = null;

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      if (await shouldStop(runId, mandate.id)) {
        await setRunStatus(runId, "STOPPED");
        await recordEvent(db(), { actor: ACTOR, type: "run.finished", mandateId: mandate.id, data: { runId, status: "STOPPED" } });
        return { runId, status: "STOPPED" as const, lastPurchase };
      }

      const res = await anthropic().beta.messages.create({
        model: AGENT_MODEL,
        max_tokens: 16000,
        system,
        tools: TOOLS,
        messages,
        output_config: { effort: "medium" },
        // Route around a safety-classifier refusal (e.g. tripped by the poisoned product text).
        ...(SUPPORTS_FALLBACK ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      });
      messages.push({ role: "assistant", content: res.content });
      for (const b of res.content) if (b.type === "text" && b.text.trim()) hooks.onText?.(b.text);

      if (res.stop_reason === "pause_turn") continue;
      if (res.stop_reason !== "tool_use") break;

      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const call of res.content) {
        if (call.type !== "tool_use") continue;
        const input = (call.input ?? {}) as Record<string, unknown>;
        let output: string;
        let isError = false;
        try {
          output = await executeTool(call.name, input, { runId, mandateId: mandate.id, callId: call.id, hooks, onPurchase: (p) => (lastPurchase = p) });
        } catch (e) {
          isError = true;
          output = e instanceof Error ? e.message : String(e);
        }
        const s: RunStep = { tool: call.name, input, output, at: new Date().toISOString() };
        await appendStep(runId, s);
        await recordEvent(db(), { actor: ACTOR, type: "run.step", mandateId: mandate.id, data: { runId, tool: call.name, input, output } });
        hooks.onStep?.(s);
        results.push({ type: "tool_result", tool_use_id: call.id, content: output, is_error: isError });
      }
      messages.push({ role: "user", content: results });
    }
    await setRunStatus(runId, "DONE");
    const summary = finishSummary(r, lastPurchase);
    await recordEvent(db(), { actor: ACTOR, type: "run.finished", mandateId: mandate.id, data: { runId, status: "DONE", summary } });
    return { runId, status: "DONE" as const, lastPurchase };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await setRunStatus(runId, "FAILED", msg);
    await recordEvent(db(), { actor: ACTOR, type: "run.finished", mandateId: mandate.id, data: { runId, status: "FAILED", error: msg } });
    return { runId, status: "FAILED" as const, lastPurchase, error: msg };
  }
}

async function executeTool(
  name: string,
  input: Record<string, unknown>,
  ctx: { runId: string; mandateId: string; callId: string; hooks: RunHooks; onPurchase: (p: PurchaseResult) => void },
): Promise<string> {
  if (name === "search_catalog") {
    const rows = await searchCatalog({
      query: String(input.query ?? ""),
      maxPriceCents: typeof input.maxPriceCents === "number" ? input.maxPriceCents : undefined,
    });
    if (!rows.length) return "No products found. Try a broader query.";
    return rows
      .map((p) => `${p.id} | ${p.name} | ${fmt(p.priceCents)} | ${p.category} | ★${p.rating ?? "-"} | ${p.blurb}`)
      .join("\n");
  }
  if (name === "get_product") {
    const p = await getProduct(String(input.productId ?? ""));
    // The description is untrusted text from the "web". It goes to the model as-is.
    return `${p.id} | ${p.name} | ${fmt(p.priceCents)} | ${p.category}\n\n${p.description}`;
  }
  if (name === "request_purchase") {
    let r = await requestPurchase({
      mandateId: ctx.mandateId, // bound by the runner, not the model
      productId: String(input.productId ?? ""),
      quantity: Number(input.quantity ?? 1),
      reason: String(input.reason ?? ""),
      actor: ACTOR,
      runId: ctx.runId,
      // One key per tool call: replaying the same call returns the same purchase, while a new
      // call is a deliberate new order (and the max-orders / no-duplicate rules judge it).
      idempotencyKey: `${ctx.runId}:${ctx.callId}`,
    });
    ctx.onPurchase(r);
    if (r.purchase.status === "HELD") {
      await setRunStatus(ctx.runId, "WAITING_APPROVAL");
      await recordEvent(db(), { actor: ACTOR, type: "run.waiting", mandateId: ctx.mandateId, purchaseId: r.purchase.id, data: { runId: ctx.runId } });
      await (ctx.hooks.onHold ?? waitForDecision)(r);
      await settleHold(r.purchase.id);
      await setRunStatus(ctx.runId, "RUNNING");
      const receipt = await getReceipt(r.purchase.id);
      r = { purchase: receipt.purchase };
      ctx.onPurchase(r);
    }
    return purchaseMessage(r);
  }
  throw new Error(`Unknown tool ${name}`);
}

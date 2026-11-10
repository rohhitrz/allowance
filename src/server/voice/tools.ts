/**
 * Voice tools (docs/03-api-design.md §6). One set of handlers for the browser push-to-talk
 * (/api/voice/local) and Vapi (/api/voice/tools). Results are short sentences to be spoken.
 * Rules live here, not in a prompt: only the exact string "approve" approves; the prompt
 * read to the user is the stored template, never model text.
 */
import { z } from "zod";
import { AppError } from "../errors";
import { confirmAndMaybeStart, listEvents, listApprovals } from "../app";
import { DEMO_USER_ID, draftMandateFromText, getMandate } from "../mandates/service";
import { summarize } from "../mandates/rules";
import { decideApproval, freezeAll, refundPurchase } from "../transactions/service";
import { fmt } from "../money";
import { db } from "../db";
import { mandates, purchases } from "../db/schema";
import { and, desc, eq } from "drizzle-orm";

const schemas = {
  create_mandate: z.object({ text: z.string().trim().min(3).max(2000) }),
  confirm_mandate: z.object({ mandateId: z.string().optional() }),
  list_activity: z.object({ limit: z.number().int().min(1).max(10).optional() }),
  get_pending_approval: z.object({}),
  decide_approval: z.object({ token: z.string().optional(), approvalId: z.string().optional(), decision: z.string() }),
  freeze_all: z.object({}),
  refund: z.object({ purchaseId: z.string().optional() }),
};
export type VoiceTool = keyof typeof schemas;
export const VOICE_TOOLS = Object.keys(schemas) as VoiceTool[];

const STATUS_WORDS: Record<string, string> = {
  CAPTURED: "bought",
  BLOCKED: "blocked",
  HELD: "waiting for you",
  VOIDED: "cancelled, no money moved",
  FAILED: "failed",
  REFUNDED: "refunded",
};

export async function runVoiceTool(name: string, rawArgs: unknown, actor: string): Promise<Record<string, unknown>> {
  if (!(name in schemas)) throw new AppError("VALIDATION_ERROR", `Unknown voice tool ${name}`);
  const tool = name as VoiceTool;
  const args = schemas[tool].parse(rawArgs ?? {}) as Record<string, unknown>;

  switch (tool) {
    case "create_mandate": {
      const r = await draftMandateFromText({ text: String(args.text), actor });
      return { mandateId: r.mandate.id, summary: r.summary };
    }
    case "confirm_mandate": {
      const mandateId = args.mandateId as string | undefined;
      if (!mandateId) {
        // "Start now" with no draft in this conversation. Never confirm a draft the user hasn't
        // heard (it may have been made by an MCP client): read the only draft's rules back and
        // wait for a yes, which comes back with this mandateId.
        const drafts = await db()
          .select()
          .from(mandates)
          .where(and(eq(mandates.userId, DEMO_USER_ID), eq(mandates.status, "DRAFT")))
          .orderBy(desc(mandates.createdAt));
        if (!drafts.length) return { status: "NONE", message: "There's no draft to start. Tell me what to buy first." };
        if (drafts.length > 1) {
          return { status: "AMBIGUOUS", message: `You have ${drafts.length} drafts. Press Confirm on the one you want; nothing was started.` };
        }
        const d = drafts[0];
        const who = d.createdBy.startsWith("mcp:") ? ` It was drafted by ${d.createdBy.slice(4)}.` : "";
        return { status: "NEEDS_CONFIRM", mandateId: d.id, message: `${summarize(d)}${who} Say yes to start it.` };
      }
      const m = await getMandate(mandateId);
      if (m.status !== "DRAFT") throw new AppError("INVALID_STATE", `That mandate is ${m.status.toLowerCase()}, not a draft`);
      const r = await confirmAndMaybeStart(mandateId, actor, true);
      return {
        status: r.mandate.status,
        message: r.run ? `Started “${r.mandate.title}”. I'm shopping now.` : `Confirmed. ${r.runError ? "The shopping agent couldn't start." : ""}`.trim(),
      };
    }
    case "list_activity": {
      const rows = await db().select().from(purchases).orderBy(desc(purchases.createdAt)).limit(Number(args.limit ?? 5));
      return {
        items: rows.map((p) => ({
          when: p.createdAt.toISOString(),
          what: `${p.quantity} × ${p.productName}, ${fmt(p.totalCents)}`,
          status: STATUS_WORDS[p.status] ?? p.status.toLowerCase(),
          why: p.failureReason ?? p.ruleResults.filter((r) => !r.passed).map((r) => r.detail).join("; "),
        })),
        events: (await listEvents({ limit: 3 })).map((e) => e.type),
      };
    }
    case "get_pending_approval": {
      // Oldest first, one at a time: the id returned here is the one the prompt was read for,
      // and the caller sends it back with the decision. The approval id stands in for the
      // token: voice is a human channel behind its own auth.
      const pending = await listApprovals("PENDING");
      const a = pending.at(-1);
      return a
        ? { approvalId: a.id, prompt: a.prompt, pendingCount: pending.length }
        : { none: true, message: "Nothing is waiting for you." };
    }
    case "decide_approval": {
      let approvalId = args.approvalId as string | undefined;
      const token = args.token as string | undefined;
      if (!approvalId && !token) {
        // No id: only safe when exactly one hold is waiting. With several we can't know which
        // one the user heard, so decide nothing and ask.
        const pending = await listApprovals("PENDING");
        if (!pending.length) return { status: "NONE", message: "Nothing is waiting for you." };
        if (pending.length > 1) {
          return {
            status: "AMBIGUOUS",
            message: `${pending.length} purchases are waiting. I'll read them one at a time; nothing was decided.`,
            pending: pending.map((a) => ({ approvalId: a.id, prompt: a.prompt })),
          };
        }
        approvalId = pending[0].id;
      }
      const decision = args.decision === "approve" ? "approve" : "reject";
      const ref = approvalId ? { approvalId } : token?.startsWith("apr_") ? { approvalId: token } : { token };
      const out = await decideApproval({ ...ref, decision, actor });
      const p = out.purchase;
      const message =
        p.status === "CAPTURED"
          ? `Approved. ${p.productName} is bought for ${fmt(p.totalCents)}.`
          : p.status === "VOIDED"
            ? decision === "approve"
              ? `I couldn't approve it: ${out.note ?? "the hold was voided"}. No money moved.`
              : `Rejected. The hold on ${p.productName} is voided; no money moved.`
            : `${p.productName} is now ${p.status.toLowerCase()}.`;
      return { status: p.status, message };
    }
    case "freeze_all": {
      const r = await freezeAll({ actor, userId: DEMO_USER_ID });
      return {
        ...r,
        message:
          `Stopped. ${r.frozen} mandate${r.frozen === 1 ? "" : "s"} frozen, ${r.voided} hold${r.voided === 1 ? "" : "s"} voided.` +
          (r.inFlight ? ` ${r.inFlight} payment${r.inFlight === 1 ? " was" : "s were"} already being charged and can't be recalled; you can refund ${r.inFlight === 1 ? "it" : "them"}.` : ""),
      };
    }
    case "refund": {
      const purchaseId = args.purchaseId as string | undefined;
      if (!purchaseId) {
        // Never pick "the latest capture" across every mandate. With exactly one refundable
        // purchase, name it and wait for a yes; with several, ask which.
        const refundable = await db()
          .select({ id: purchases.id, productName: purchases.productName, totalCents: purchases.totalCents, recovery: purchases.recovery })
          .from(purchases)
          .innerJoin(mandates, eq(mandates.id, purchases.mandateId))
          .where(and(eq(mandates.userId, DEMO_USER_ID), eq(purchases.status, "CAPTURED")))
          .orderBy(desc(purchases.createdAt));
        const ok = refundable.filter((p) => p.recovery === null);
        if (!ok.length) return { status: "NONE", message: "There's nothing to refund." };
        if (ok.length > 1) {
          return { status: "AMBIGUOUS", message: `${ok.length} purchases can be refunded. Open the one you mean from the ledger and press Refund; nothing was refunded.` };
        }
        return { status: "NEEDS_CONFIRM", purchaseId: ok[0].id, message: `Refund ${ok[0].productName}, ${fmt(ok[0].totalCents)}? Say yes to refund it.` };
      }
      const p = await refundPurchase(purchaseId, actor);
      return p.status === "REFUNDED"
        ? { status: p.status, message: `Refunded ${p.productName}, ${fmt(p.totalCents)}. That budget is free again.` }
        : { status: p.status, message: `PayPal is still processing the refund for ${p.productName}. It counts as spent until it completes.` };
    }
  }
}

/** Tool definitions for Vapi's assistant config (and docs). */
export const VAPI_TOOL_DEFS = [
  { name: "create_mandate", description: "Turn what the user said into a draft spending mandate. Read the returned summary back word for word and ask them to confirm.", parameters: { type: "object", properties: { text: { type: "string", description: "The user's words" } }, required: ["text"] } },
  { name: "confirm_mandate", description: "Confirm a draft mandate after the user clearly said yes to its read-back. Starts the shopping agent. Without mandateId nothing is started: it returns the only draft's read-back (status NEEDS_CONFIRM) to read out, and you call again with that mandateId after a clear yes.", parameters: { type: "object", properties: { mandateId: { type: "string" } } } },
  { name: "list_activity", description: "Recent purchase attempts as short sentences.", parameters: { type: "object", properties: { limit: { type: "integer" } } } },
  { name: "get_pending_approval", description: "The oldest purchase waiting for the user: its approvalId and the exact prompt to read out. Call this before decide_approval.", parameters: { type: "object", properties: {} } },
  { name: "decide_approval", description: "Send the user's answer for the approvalId whose prompt you just read out. Use decision 'approve' only if they clearly said approve; otherwise 'reject'.", parameters: { type: "object", properties: { approvalId: { type: "string" }, decision: { type: "string", enum: ["approve", "reject"] } }, required: ["approvalId", "decision"] } },
  { name: "freeze_all", description: "Kill switch: freeze every mandate and void open holds. Use when the user says stop.", parameters: { type: "object", properties: {} } },
  { name: "refund", description: "Refund a captured purchase. Without purchaseId nothing is refunded: with one refundable purchase it returns NEEDS_CONFIRM and its purchaseId to read out and confirm; with several it asks which.", parameters: { type: "object", properties: { purchaseId: { type: "string" } } } },
];

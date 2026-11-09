/**
 * Voice tools (docs/03-api-design.md §6). One set of handlers for the browser push-to-talk
 * (/api/voice/local) and Vapi (/api/voice/tools). Results are short sentences to be spoken.
 * Rules live here, not in a prompt: only the exact string "approve" approves; the prompt
 * read to the user is the stored template, never model text.
 */
import { z } from "zod";
import { AppError } from "../errors";
import { confirmAndMaybeStart, listEvents, listApprovals } from "../app";
import { DEMO_USER_ID, draftMandateFromText } from "../mandates/service";
import { decideApproval, freezeAll, refundPurchase } from "../transactions/service";
import { fmt } from "../money";
import { db } from "../db";
import { purchases } from "../db/schema";
import { desc, eq } from "drizzle-orm";

const schemas = {
  create_mandate: z.object({ text: z.string().trim().min(3).max(2000) }),
  confirm_mandate: z.object({ mandateId: z.string() }),
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
      const r = await confirmAndMaybeStart(String(args.mandateId), actor, true);
      return {
        status: r.mandate.status,
        message: r.run ? "Done. I'm shopping now." : `Confirmed. ${r.runError ? "The shopping agent couldn't start." : ""}`.trim(),
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
        message: `Stopped. ${r.frozen} mandate${r.frozen === 1 ? "" : "s"} frozen, ${r.voided} hold${r.voided === 1 ? "" : "s"} voided.`,
      };
    }
    case "refund": {
      let purchaseId = args.purchaseId as string | undefined;
      if (!purchaseId) {
        const [last] = await db().select().from(purchases).where(eq(purchases.status, "CAPTURED")).orderBy(desc(purchases.createdAt)).limit(1);
        if (!last) return { message: "There's nothing to refund." };
        purchaseId = last.id;
      }
      const p = await refundPurchase(purchaseId, actor);
      return { status: p.status, message: `Refunded ${p.productName}, ${fmt(p.totalCents)}. That budget is free again.` };
    }
  }
}

/** Tool definitions for Vapi's assistant config (and docs). */
export const VAPI_TOOL_DEFS = [
  { name: "create_mandate", description: "Turn what the user said into a draft spending mandate. Read the returned summary back word for word and ask them to confirm.", parameters: { type: "object", properties: { text: { type: "string", description: "The user's words" } }, required: ["text"] } },
  { name: "confirm_mandate", description: "Confirm a draft mandate after the user clearly said yes. Starts the shopping agent.", parameters: { type: "object", properties: { mandateId: { type: "string" } }, required: ["mandateId"] } },
  { name: "list_activity", description: "Recent purchase attempts as short sentences.", parameters: { type: "object", properties: { limit: { type: "integer" } } } },
  { name: "get_pending_approval", description: "The oldest purchase waiting for the user: its approvalId and the exact prompt to read out. Call this before decide_approval.", parameters: { type: "object", properties: {} } },
  { name: "decide_approval", description: "Send the user's answer for the approvalId whose prompt you just read out. Use decision 'approve' only if they clearly said approve; otherwise 'reject'.", parameters: { type: "object", properties: { approvalId: { type: "string" }, decision: { type: "string", enum: ["approve", "reject"] } }, required: ["approvalId", "decision"] } },
  { name: "freeze_all", description: "Kill switch: freeze every mandate and void open holds. Use when the user says stop.", parameters: { type: "object", properties: {} } },
  { name: "refund", description: "Refund a captured purchase (the latest one if no id).", parameters: { type: "object", properties: { purchaseId: { type: "string" } } } },
];

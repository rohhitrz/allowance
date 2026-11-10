/**
 * Read models + orchestration shared by every surface (REST, voice, MCP).
 * Money still only moves through transactions/service.ts.
 */
import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { db } from "./db";
import { agentRuns, approvals, events, paypalVaults, purchases, type MandateRow, type PurchaseRow } from "./db/schema";
import { approvalDto, purchaseDto } from "./dto";
import { AppError } from "./errors";
import { GROCERY_MANDATE_ID } from "./db/seed";
import { recoverStaleRuns, startRun } from "./agent/runner";
import { startRedTeamRun } from "./agent/redteam";
import { confirmMandate, DEMO_USER_ID } from "./mandates/service";
import { pendingApprovals } from "./transactions/service";

type PurchaseStatus = PurchaseRow["status"];

export async function listPurchases(opts: { mandateId?: string; status?: PurchaseStatus; limit?: number } = {}) {
  const rows = await db()
    .select({ p: purchases, approvalId: approvals.id })
    .from(purchases)
    .leftJoin(approvals, eq(approvals.purchaseId, purchases.id))
    .where(
      and(
        opts.mandateId ? eq(purchases.mandateId, opts.mandateId) : undefined,
        opts.status ? eq(purchases.status, opts.status) : undefined,
      ),
    )
    .orderBy(desc(purchases.createdAt))
    .limit(opts.limit ?? 500);
  return rows.map((r) => purchaseDto(r.p, r.approvalId));
}

export async function getPurchaseDto(purchaseId: string) {
  const [r] = await db()
    .select({ p: purchases, approvalId: approvals.id })
    .from(purchases)
    .leftJoin(approvals, eq(approvals.purchaseId, purchases.id))
    .where(eq(purchases.id, purchaseId));
  if (!r) throw new AppError("NOT_FOUND", `Unknown purchase ${purchaseId}`);
  return purchaseDto(r.p, r.approvalId);
}

export async function listApprovals(status?: "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED" | "CANCELLED") {
  // A plain read: holds past their expiry are left out; the 60 s sweep voids them.
  if (status === "PENDING") return (await pendingApprovals()).map((r) => approvalDto(r.approval, r.purchase));
  const rows = await db()
    .select({ a: approvals, p: purchases })
    .from(approvals)
    .innerJoin(purchases, eq(purchases.id, approvals.purchaseId))
    .where(status ? eq(approvals.status, status) : undefined)
    .orderBy(desc(approvals.createdAt))
    .limit(200);
  // A hold past its expiry can't be approved any more, even if the sweep hasn't voided it yet.
  const now = new Date();
  return rows.map((r) => approvalDto(r.a.status === "PENDING" && r.a.expiresAt <= now ? { ...r.a, status: "EXPIRED" } : r.a, r.p));
}

export async function listEvents(opts: { since?: number; mandateId?: string; limit?: number } = {}) {
  const rows = await db()
    .select()
    .from(events)
    .where(
      and(
        opts.since !== undefined ? gt(events.id, opts.since) : undefined,
        opts.mandateId ? eq(events.mandateId, opts.mandateId) : undefined,
      ),
    )
    .orderBy(opts.since !== undefined ? events.id : desc(events.id))
    .limit(Math.min(opts.limit ?? 100, 500));
  return opts.since !== undefined ? rows : rows.reverse();
}

// ---------- agent runs ----------

/** Start the shopping agent in the background. The run waits on holds and resumes after a human decides. */
export async function startAgentRun(mandateId: string, brief?: string) {
  await recoverStaleRuns({ mandateId }); // an orphaned run from a restart must not block the mandate forever
  const busy = await db()
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(and(eq(agentRuns.mandateId, mandateId), inArray(agentRuns.status, ["RUNNING", "WAITING_APPROVAL"])));
  if (busy.length) throw new AppError("INVALID_STATE", `An agent run is already active on this mandate (${busy[0].id})`);
  if (!process.env.ANTHROPIC_API_KEY) throw new AppError("INVALID_STATE", "ANTHROPIC_API_KEY is not set; the live agent can't run");
  const { runId, done } = await startRun({ mandateId, brief });
  done.catch((e) => console.error("[agent] run crashed", runId, e));
  return getRun(runId);
}

/** Start the red-team agent (Claude, told to break this mandate) in the background. */
export async function startRedTeam(mandateId: string) {
  await recoverStaleRuns({ mandateId }); // an orphaned run from a restart must not block the mandate forever
  const busy = await db()
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(and(eq(agentRuns.mandateId, mandateId), inArray(agentRuns.status, ["RUNNING", "WAITING_APPROVAL"])));
  if (busy.length) throw new AppError("INVALID_STATE", `An agent run is already active on this mandate (${busy[0].id})`);
  if (!process.env.ANTHROPIC_API_KEY) throw new AppError("INVALID_STATE", "ANTHROPIC_API_KEY is not set; the red-team agent can't run");
  const { runId, done } = await startRedTeamRun(mandateId);
  done.catch((e) => console.error("[red team] run crashed", runId, e));
  return getRun(runId);
}

export async function getRun(runId: string) {
  const [r] = await db().select().from(agentRuns).where(eq(agentRuns.id, runId));
  if (!r) throw new AppError("NOT_FOUND", `Unknown run ${runId}`);
  return r;
}

export async function listRuns(mandateId?: string) {
  return db()
    .select()
    .from(agentRuns)
    .where(mandateId ? eq(agentRuns.mandateId, mandateId) : undefined)
    .orderBy(desc(agentRuns.startedAt))
    .limit(50);
}

/** The runner checks this flag between steps. */
export async function stopRun(runId: string) {
  await db()
    .update(agentRuns)
    .set({ status: "STOPPED", endedAt: new Date() })
    .where(and(eq(agentRuns.id, runId), inArray(agentRuns.status, ["RUNNING", "WAITING_APPROVAL"])));
  return getRun(runId);
}

/** Confirm (human only), then start shopping unless told not to. */
export async function confirmAndMaybeStart(mandateId: string, actor: string, startAgent = true) {
  const mandate = await confirmMandate(mandateId, actor);
  let run = null;
  let runError: string | undefined;
  if (startAgent) {
    try {
      run = await startAgentRun(mandate.id);
    } catch (e) {
      runError = e instanceof Error ? e.message : String(e);
    }
  }
  return { mandate, run, runError };
}

// ---------- misc ----------

export async function vaultStatus(userId = DEMO_USER_ID) {
  const [v] = await db()
    .select()
    .from(paypalVaults)
    .where(and(eq(paypalVaults.userId, userId), eq(paypalVaults.status, "ACTIVE")));
  return v ? { linked: true, payerEmail: v.payerEmail ?? undefined } : { linked: false };
}

/** Mandates any MCP client may use (the seeded grocery mandate); everything else is private to its creator. */
export const SHARED_MANDATE_IDS = new Set([GROCERY_MANDATE_ID]);

export function mandateOwnedBy(m: Pick<MandateRow, "id" | "apiClientId">, apiClientId: string) {
  return m.apiClientId === apiClientId || SHARED_MANDATE_IDS.has(m.id);
}

export async function dbUp() {
  try {
    await db().execute(sql`select 1`);
    return true;
  } catch {
    return false;
  }
}


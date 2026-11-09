/**
 * Mandate service: draft (from text via Claude, or structured), confirm, cancel,
 * unfreeze, read. Every version change writes an immutable mandate_versions row.
 */
import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { db, type Conn } from "../db";
import { approvals, mandates, mandateVersions, purchases, type MandateRow } from "../db/schema";
import { AppError, assertHuman } from "../errors";
import { inTransaction, recordEvent } from "../events/bus";
import { id } from "../ids";
import { usd } from "../money";
import { voidPurchase } from "../transactions/service";
import { parseMandateText } from "./parser";
import { applyDefaults, summarize, toRules, type MandateDraftInput } from "./rules";
import { getSpend } from "./spend";

export const DEMO_USER_ID = "usr_demo";
export const DEFAULT_TZ = "Asia/Kolkata";

async function snapshot(conn: Conn, m: MandateRow, actor: string) {
  await conn
    .insert(mandateVersions)
    .values({ mandateId: m.id, version: m.version, rules: toRules(m), createdBy: actor })
    .onConflictDoNothing();
}

async function load(conn: Conn, mandateId: string, lock = false): Promise<MandateRow> {
  const q = conn.select().from(mandates).where(eq(mandates.id, mandateId));
  const [m] = lock ? await q.for("update") : await q;
  if (!m) throw new AppError("NOT_FOUND", `Unknown mandate ${mandateId}`);
  return m;
}

/** Text -> Claude -> draft. Any actor may draft; only a human may confirm. */
export async function draftMandateFromText(args: {
  text: string;
  actor: string;
  userId?: string;
  apiClientId?: string;
  now?: Date;
}) {
  const now = args.now ?? new Date();
  const parsed = await parseMandateText(args.text, { now, timezone: DEFAULT_TZ });
  return createDraft({ ...args, draft: parsed, now });
}

export async function createDraft(args: {
  draft: MandateDraftInput;
  text: string;
  actor: string;
  userId?: string;
  apiClientId?: string;
  now?: Date;
  id?: string;
}) {
  const now = args.now ?? new Date();
  let resolved;
  try {
    resolved = applyDefaults(args.draft, { now, timezone: DEFAULT_TZ });
  } catch (e) {
    throw new AppError("PARSE_FAILED", e instanceof Error ? e.message : String(e), { draft: args.draft });
  }
  const m = await inTransaction(async (tx) => {
    const [m] = await tx
      .insert(mandates)
      .values({
        id: args.id ?? id("man"),
        userId: args.userId ?? DEMO_USER_ID,
        createdBy: args.actor,
        apiClientId: args.apiClientId ?? null,
        sourceText: args.text,
        status: "DRAFT",
        version: 0,
        ...resolved,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    await snapshot(tx, m, args.actor);
    await recordEvent(tx, { actor: args.actor, type: "mandate.drafted", mandateId: m.id, data: { title: m.title } });
    return m;
  });
  return { mandate: m, summary: summarize(m) };
}

export async function confirmMandate(mandateId: string, actor: string) {
  assertHuman(actor);
  return inTransaction(async (tx) => {
    const m = await load(tx, mandateId, true);
    if (m.status !== "DRAFT") throw new AppError("INVALID_STATE", `Mandate is ${m.status}`);
    const now = new Date();
    const [row] = await tx
      .update(mandates)
      .set({ status: "ACTIVE", version: 1, confirmedAt: now, updatedAt: now })
      .where(eq(mandates.id, m.id))
      .returning();
    await snapshot(tx, row, actor);
    await recordEvent(tx, { actor, type: "mandate.confirmed", mandateId: m.id, data: { version: 1 } });
    return row;
  });
}

/** FROZEN -> ACTIVE with version + 1, so approvals issued before the freeze stay dead. */
export async function unfreezeMandate(mandateId: string, actor: string) {
  assertHuman(actor);
  return inTransaction(async (tx) => {
    const m = await load(tx, mandateId, true);
    if (m.status !== "FROZEN") throw new AppError("INVALID_STATE", `Mandate is ${m.status}`);
    const [row] = await tx
      .update(mandates)
      .set({ status: "ACTIVE", version: m.version + 1, frozenAt: null, updatedAt: new Date() })
      .where(eq(mandates.id, m.id))
      .returning();
    await snapshot(tx, row, actor);
    await recordEvent(tx, { actor, type: "mandate.unfrozen", mandateId: m.id, data: { version: row.version } });
    return row;
  });
}

export async function cancelMandate(mandateId: string, actor: string) {
  assertHuman(actor);
  const { row, held } = await inTransaction(async (tx) => {
    const m = await load(tx, mandateId, true);
    if (m.status === "CANCELLED" || m.status === "EXPIRED") throw new AppError("INVALID_STATE", `Mandate is ${m.status}`);
    const [row] = await tx
      .update(mandates)
      .set({ status: "CANCELLED", updatedAt: new Date() })
      .where(eq(mandates.id, m.id))
      .returning();
    const held = await tx
      .update(approvals)
      .set({ status: "CANCELLED", decidedBy: actor, decidedAt: new Date() })
      .where(
        and(
          eq(approvals.status, "PENDING"),
          inArray(approvals.purchaseId, tx.select({ id: purchases.id }).from(purchases).where(eq(purchases.mandateId, m.id))),
        ),
      )
      .returning({ purchaseId: approvals.purchaseId });
    await recordEvent(tx, { actor, type: "mandate.cancelled", mandateId: m.id });
    return { row, held };
  });
  for (const h of held) await voidPurchase(h.purchaseId, actor, "mandate cancelled").catch(() => {});
  return row;
}

/** Mark ACTIVE mandates past expires_at as EXPIRED. The engine blocks them either way. */
export async function expireMandates(now = new Date()) {
  const rows = await db()
    .update(mandates)
    .set({ status: "EXPIRED", updatedAt: now })
    .where(and(eq(mandates.status, "ACTIVE"), lt(mandates.expiresAt, now)))
    .returning();
  for (const r of rows) await recordEvent(db(), { actor: "system", type: "mandate.expired", mandateId: r.id });
  return rows;
}

export async function withSpend(m: MandateRow, now = new Date()) {
  const s = await getSpend(db(), m, now);
  return {
    ...m,
    rules: toRules(m),
    spend: {
      amount: usd(s.spend.amountCents),
      orders: s.spend.orders,
      periodStart: s.periodStart.toISOString(),
      periodEnd: s.periodEnd?.toISOString() ?? null,
    },
  };
}

export async function getMandate(mandateId: string) {
  return withSpend(await load(db(), mandateId));
}

export async function listMandates(opts: { status?: MandateRow["status"] } = {}) {
  const rows = await db()
    .select()
    .from(mandates)
    .where(opts.status ? eq(mandates.status, opts.status) : undefined)
    .orderBy(desc(mandates.createdAt));
  return Promise.all(rows.map((m) => withSpend(m)));
}

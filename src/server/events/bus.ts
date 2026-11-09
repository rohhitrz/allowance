/**
 * Append-only audit log + in-memory bus (SSE reads from the bus in stage 3).
 * One app instance, so an EventEmitter is enough.
 */
import { EventEmitter } from "node:events";
import { db, type Conn, type Tx } from "../db";
import { events, type EventRow } from "../db/schema";

export type Actor = `user:${string}` | `mcp:${string}` | "agent:allowance" | "system";

export type EventType =
  | "mandate.drafted"
  | "mandate.confirmed"
  | "mandate.frozen"
  | "mandate.unfrozen"
  | "mandate.cancelled"
  | "mandate.expired"
  | "run.started"
  | "run.step"
  | "run.waiting"
  | "run.finished"
  | "purchase.proposed"
  | "purchase.blocked"
  | "purchase.reserved"
  | "purchase.authorized"
  | "purchase.held"
  | "purchase.captured"
  | "purchase.voided"
  | "purchase.failed"
  | "purchase.refunded"
  | "purchase.refund_pending"
  | "purchase.refund_failed"
  | "approval.created"
  | "approval.decided"
  | "approval.expired"
  | "vault.linked";

const g = globalThis as unknown as { __allowanceBus?: EventEmitter };
export const bus: EventEmitter = (g.__allowanceBus ??= new EventEmitter().setMaxListeners(100));

/** Events recorded inside an open transaction wait here until it commits. */
const pendingByTx = new WeakMap<object, (() => void)[]>();

/**
 * Run fn in a DB transaction. Events (and any after-commit callbacks) go to live
 * listeners only once it commits; if it rolls back, they're dropped.
 */
export async function inTransaction<T>(fn: (tx: Tx, afterCommit: (cb: () => void) => void) => Promise<T>): Promise<T> {
  const pending: (() => void)[] = [];
  const result = await db().transaction(async (tx) => {
    pendingByTx.set(tx, pending);
    return fn(tx, (cb) => pending.push(cb));
  });
  for (const cb of pending) cb();
  return result;
}

export async function recordEvent(
  conn: Conn,
  ev: { actor: string; type: EventType; mandateId?: string; purchaseId?: string; data?: Record<string, unknown> },
): Promise<EventRow> {
  const [row] = await conn
    .insert(events)
    .values({
      actor: ev.actor,
      type: ev.type,
      mandateId: ev.mandateId ?? null,
      purchaseId: ev.purchaseId ?? null,
      data: ev.data ?? {},
    })
    .returning();
  const pending = pendingByTx.get(conn);
  if (pending) pending.push(() => bus.emit("event", row));
  else bus.emit("event", row);
  return row;
}

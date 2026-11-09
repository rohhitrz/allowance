/**
 * Append-only audit log + in-memory bus (SSE reads from the bus in stage 3).
 * One app instance, so an EventEmitter is enough.
 */
import { EventEmitter } from "node:events";
import type { Conn } from "../db";
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
  | "approval.created"
  | "approval.decided"
  | "approval.expired"
  | "vault.linked";

const g = globalThis as unknown as { __allowanceBus?: EventEmitter };
export const bus: EventEmitter = (g.__allowanceBus ??= new EventEmitter().setMaxListeners(100));

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
  bus.emit("event", row);
  return row;
}

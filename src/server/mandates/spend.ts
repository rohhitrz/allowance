/**
 * Spend is computed, never stored: a SUM over live purchases in the current window.
 * Call it inside the transaction that holds the mandate row lock.
 */
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { Conn } from "../db";
import { purchases, type MandateRow } from "../db/schema";
import { periodEnd, periodStart } from "../policy/period";
import { LIVE_PURCHASE_STATUSES, type Spend } from "../policy/types";

export function windowFor(m: Pick<MandateRow, "period" | "timezone" | "createdAt">, now: Date) {
  const start = periodStart({ period: m.period, timezone: m.timezone, mandateCreatedAt: m.createdAt, now });
  return { start, end: periodEnd({ period: m.period, timezone: m.timezone, start }) };
}

export async function getSpend(
  conn: Conn,
  m: Pick<MandateRow, "id" | "period" | "timezone" | "createdAt">,
  now: Date,
  excludePurchaseId?: string,
): Promise<{ spend: Spend; periodStart: Date; periodEnd: Date | null }> {
  const { start, end } = windowFor(m, now);
  const [row] = await conn
    .select({
      amount: sql<string>`COALESCE(SUM(${purchases.totalCents}), 0)`,
      orders: sql<string>`COUNT(*)`,
      productIds: sql<string[] | null>`ARRAY_AGG(${purchases.productId})`,
    })
    .from(purchases)
    .where(
      and(
        eq(purchases.mandateId, m.id),
        eq(purchases.periodStart, start),
        inArray(purchases.status, [...LIVE_PURCHASE_STATUSES]),
        excludePurchaseId ? ne(purchases.id, excludePurchaseId) : undefined,
      ),
    );
  return {
    spend: { amountCents: Number(row.amount), orders: Number(row.orders), productIds: row.productIds ?? [] },
    periodStart: start,
    periodEnd: end,
  };
}

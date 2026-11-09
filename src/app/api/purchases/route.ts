import { route, json, body } from "@/server/http/handler";
import { requireUser } from "@/server/http/auth";
import { z } from "zod";
import { getPurchaseDto, listPurchases } from "@/server/app";
import { requestPurchase } from "@/server/transactions/service";
import { getReceipt } from "@/server/receipts";

const STATUS = z.enum(["PROPOSED", "BLOCKED", "RESERVED", "AUTHORIZED", "HELD", "CAPTURED", "VOIDED", "FAILED", "REFUNDED"]).optional();

export const GET = route(async (req) => {
  requireUser(req);
  const q = new URL(req.url).searchParams;
  return json({ purchases: await listPurchases({ mandateId: q.get("mandateId") ?? undefined, status: STATUS.parse(q.get("status") ?? undefined) }) });
});

/** The one money entry point (dashboard debug). Policy outcomes are 201s, never errors. */
export const POST = route(async (req) => {
  const actor = requireUser(req);
  const b = await body(
    req,
    z.object({ mandateId: z.string(), productId: z.string(), quantity: z.number().int().min(1).max(1000), reason: z.string().max(500).default("") }),
  );
  const r = await requestPurchase({ ...b, actor, idempotencyKey: req.headers.get("idempotency-key") ?? undefined });
  return json({ purchase: await getPurchaseDto(r.purchase.id), receipt: await getReceipt(r.purchase.id), approval: r.approval }, 201);
});

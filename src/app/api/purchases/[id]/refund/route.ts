import { route, json, body, type Ctx } from "@/server/http/handler";
import { requireUser } from "@/server/http/auth";
import { z } from "zod";
import { refundPurchase } from "@/server/transactions/service";
import { getPurchaseDto } from "@/server/app";

export const POST = route(async (req, ctx: Ctx<{ id: string }>) => {
  const actor = requireUser(req);
  const { id } = await ctx.params;
  const { reason } = await body(req, z.object({ reason: z.string().max(255).optional() }));
  await refundPurchase(id, actor, reason);
  return json({ purchase: await getPurchaseDto(id) });
});

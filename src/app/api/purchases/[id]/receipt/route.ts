import { route, json, type Ctx } from "@/server/http/handler";
import { requireUser } from "@/server/http/auth";
import { getReceipt } from "@/server/receipts";
import { getPurchaseDto } from "@/server/app";

export const GET = route(async (req, ctx: Ctx<{ id: string }>) => {
  requireUser(req);
  const { id } = await ctx.params;
  const receipt = await getReceipt(id);
  return json({ receipt: { ...receipt, purchase: await getPurchaseDto(id) } });
});

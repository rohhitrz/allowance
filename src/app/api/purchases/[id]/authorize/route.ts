import { route, json, type Ctx } from "@/server/http/handler";
import { requireUser } from "@/server/http/auth";
import { completeFallbackAuthorization } from "@/server/transactions/service";
import { getPurchaseDto } from "@/server/app";

/** No-vault fallback only: called after the buyer approved the PayPal popup. */
export const POST = route(async (req, ctx: Ctx<{ id: string }>) => {
  const actor = requireUser(req);
  const { id } = await ctx.params;
  await completeFallbackAuthorization(id, actor);
  return json({ purchase: await getPurchaseDto(id) });
});

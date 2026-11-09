import { route, json, type Ctx } from "@/server/http/handler";
import { requireUser } from "@/server/http/auth";
import { getMandate, unfreezeMandate } from "@/server/mandates/service";

export const POST = route(async (req, ctx: Ctx<{ id: string }>) => {
  const actor = requireUser(req);
  const { id } = await ctx.params;
  await unfreezeMandate(id, actor);
  return json({ mandate: await getMandate(id) });
});

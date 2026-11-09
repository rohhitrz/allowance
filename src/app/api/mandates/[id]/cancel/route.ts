import { route, json, type Ctx } from "@/server/http/handler";
import { requireUser } from "@/server/http/auth";
import { cancelMandate, getMandate } from "@/server/mandates/service";

export const POST = route(async (req, ctx: Ctx<{ id: string }>) => {
  const actor = requireUser(req);
  const { id } = await ctx.params;
  await cancelMandate(id, actor);
  return json({ mandate: await getMandate(id) });
});

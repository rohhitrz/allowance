import { route, json, type Ctx } from "@/server/http/handler";
import { requireUser } from "@/server/http/auth";
import { getPurchaseDto } from "@/server/app";

export const GET = route(async (req, ctx: Ctx<{ id: string }>) => {
  requireUser(req);
  return json({ purchase: await getPurchaseDto((await ctx.params).id) });
});

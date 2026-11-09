import { route, json, type Ctx } from "@/server/http/handler";
import { requireUser } from "@/server/http/auth";
import { getProduct } from "@/server/catalog/service";

export const GET = route(async (req, ctx: Ctx<{ id: string }>) => {
  requireUser(req);
  return json({ product: await getProduct((await ctx.params).id) });
});

import { route, json, type Ctx } from "@/server/http/handler";
import { requireUser } from "@/server/http/auth";
import { getMandate } from "@/server/mandates/service";
import { listPurchases, listRuns } from "@/server/app";

export const GET = route(async (req, ctx: Ctx<{ id: string }>) => {
  requireUser(req);
  const { id } = await ctx.params;
  const mandate = await getMandate(id);
  return json({ mandate, purchases: await listPurchases({ mandateId: id }), runs: await listRuns(id) });
});

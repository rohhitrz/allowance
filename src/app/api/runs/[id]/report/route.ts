import { route, json, type Ctx } from "@/server/http/handler";
import { requireUser } from "@/server/http/auth";
import { redTeamReport } from "@/server/agent/redteam";

export const GET = route(async (req, ctx: Ctx<{ id: string }>) => {
  requireUser(req);
  return json({ report: await redTeamReport((await ctx.params).id) });
});

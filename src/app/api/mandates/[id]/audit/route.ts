import { route, json, type Ctx } from "@/server/http/handler";
import { requireUser } from "@/server/http/auth";
import { auditMandate } from "@/server/audit";

export const GET = route(async (req, ctx: Ctx<{ id: string }>) => {
  requireUser(req);
  return json({ audit: await auditMandate((await ctx.params).id) });
});

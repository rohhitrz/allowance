import { route, json, type Ctx } from "@/server/http/handler";
import { requireUser } from "@/server/http/auth";
import { getRun } from "@/server/app";

export const GET = route(async (req, ctx: Ctx<{ id: string }>) => {
  requireUser(req);
  return json({ run: await getRun((await ctx.params).id) });
});

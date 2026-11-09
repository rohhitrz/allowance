import { route, json, type Ctx } from "@/server/http/handler";
import { requireUser } from "@/server/http/auth";
import { stopRun } from "@/server/app";

export const POST = route(async (req, ctx: Ctx<{ id: string }>) => {
  requireUser(req);
  return json({ run: await stopRun((await ctx.params).id) });
});

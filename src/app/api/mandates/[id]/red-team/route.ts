import { route, json, type Ctx } from "@/server/http/handler";
import { requireUser } from "@/server/http/auth";
import { startRedTeam } from "@/server/app";

/** Let Claude attack this mandate. Same services and the same PayPal sandbox as a real agent. */
export const POST = route(async (req, ctx: Ctx<{ id: string }>) => {
  requireUser(req);
  return json({ run: await startRedTeam((await ctx.params).id) }, 202);
});

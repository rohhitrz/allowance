import { route, json, body, type Ctx } from "@/server/http/handler";
import { requireUser } from "@/server/http/auth";
import { z } from "zod";
import { confirmAndMaybeStart } from "@/server/app";
import { getMandate } from "@/server/mandates/service";

export const POST = route(async (req, ctx: Ctx<{ id: string }>) => {
  const actor = requireUser(req);
  const { id } = await ctx.params;
  const { startAgent } = await body(req, z.object({ startAgent: z.boolean().default(true) }));
  const r = await confirmAndMaybeStart(id, actor, startAgent);
  return json({ mandate: await getMandate(r.mandate.id), run: r.run, runError: r.runError });
});

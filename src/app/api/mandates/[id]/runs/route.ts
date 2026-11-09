import { route, json, body, type Ctx } from "@/server/http/handler";
import { requireUser } from "@/server/http/auth";
import { z } from "zod";
import { startAgentRun } from "@/server/app";

export const POST = route(async (req, ctx: Ctx<{ id: string }>) => {
  requireUser(req);
  const { id } = await ctx.params;
  const { brief } = await body(req, z.object({ brief: z.string().trim().min(1).max(2000).optional() }));
  return json({ run: await startAgentRun(id, brief) }, 202);
});

import { z } from "zod";
import { route, json, body } from "@/server/http/handler";
import { requireUser } from "@/server/http/auth";
import { runVoiceTool } from "@/server/voice/tools";

/** Browser push-to-talk: same handlers as Vapi, cookie auth, recorded as user:voice. */
export const POST = route(async (req) => {
  requireUser(req);
  const { tool, args } = await body(req, z.object({ tool: z.string(), args: z.record(z.string(), z.unknown()).default({}) }));
  return json({ result: await runVoiceTool(tool, args, "user:voice") });
});

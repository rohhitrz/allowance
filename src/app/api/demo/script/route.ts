import { z } from "zod";
import { route, json, body, demoOnly } from "@/server/http/handler";
import { requireUser } from "@/server/http/auth";
import { DEMO_STEPS, runDemoStep } from "@/server/demo/script";

export const POST = route(async (req) => {
  requireUser(req);
  demoOnly();
  const { step } = await body(req, z.object({ step: z.enum(DEMO_STEPS) }));
  return json({ step, result: await runDemoStep(step) });
});

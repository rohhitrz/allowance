import { route, json, demoOnly } from "@/server/http/handler";
import { requireUser } from "@/server/http/auth";
import { resetDemoData } from "@/server/demo/script";

export const POST = route(async (req) => {
  requireUser(req);
  demoOnly();
  await resetDemoData();
  return json({ ok: true });
});

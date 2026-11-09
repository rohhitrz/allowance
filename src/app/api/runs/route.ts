import { route, json } from "@/server/http/handler";
import { requireUser } from "@/server/http/auth";
import { listRuns } from "@/server/app";

export const GET = route(async (req) => {
  requireUser(req);
  return json({ runs: await listRuns(new URL(req.url).searchParams.get("mandateId") ?? undefined) });
});

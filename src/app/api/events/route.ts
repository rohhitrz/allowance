import { route, json } from "@/server/http/handler";
import { requireUser } from "@/server/http/auth";
import { listEvents } from "@/server/app";

export const GET = route(async (req) => {
  requireUser(req);
  const q = new URL(req.url).searchParams;
  const since = q.get("since");
  return json({
    events: await listEvents({ since: since ? Number(since) : undefined, mandateId: q.get("mandateId") ?? undefined, limit: Number(q.get("limit") ?? 100) }),
  });
});

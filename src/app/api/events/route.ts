import { route, json, intParam } from "@/server/http/handler";
import { requireUser } from "@/server/http/auth";
import { listEvents } from "@/server/app";

export const GET = route(async (req) => {
  requireUser(req);
  const q = new URL(req.url).searchParams;
  return json({
    events: await listEvents({
      since: intParam(q.get("since"), "since"),
      mandateId: q.get("mandateId") ?? undefined,
      limit: intParam(q.get("limit"), "limit", { min: 1, max: 500 }),
    }),
  });
});

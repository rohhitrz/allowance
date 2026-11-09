import { route, json } from "@/server/http/handler";
import { requireUser } from "@/server/http/auth";
import { freezeAll } from "@/server/transactions/service";
import { DEMO_USER_ID } from "@/server/mandates/service";

export const POST = route(async (req) => {
  const actor = requireUser(req);
  return json(await freezeAll({ actor, userId: DEMO_USER_ID }));
});

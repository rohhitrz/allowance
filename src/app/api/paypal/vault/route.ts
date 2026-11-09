import { route, json } from "@/server/http/handler";
import { requireUser } from "@/server/http/auth";
import { vaultStatus } from "@/server/app";

export const GET = route(async (req) => {
  requireUser(req);
  return json(await vaultStatus());
});

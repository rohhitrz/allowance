import { route, json } from "@/server/http/handler";
import { requireUser } from "@/server/http/auth";
import { startVaultSetup } from "@/server/paypal/vault";

export const POST = route(async (req) => json(await startVaultSetup(requireUser(req))));

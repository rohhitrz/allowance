import { appBaseUrl } from "@/server/base-url";
import { requireUser } from "@/server/http/auth";
import { finishVaultSetup } from "@/server/paypal/vault";

/** PayPal sends the buyer back here after they approve saving their PayPal account. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const home = new URL("/", appBaseUrl(url.origin));
  try {
    requireUser(req);
    const setupToken = url.searchParams.get("approval_token_id");
    if (!setupToken) throw new Error("missing approval_token_id");
    await finishVaultSetup(setupToken);
    home.searchParams.set("vault", "linked");
  } catch (e) {
    home.searchParams.set("vault", "error");
    home.searchParams.set("message", e instanceof Error ? e.message.slice(0, 200) : "failed");
  }
  return Response.redirect(home, 303);
}

import { appBaseUrl } from "@/server/base-url";
import { requireUser } from "@/server/http/auth";
import { completeFallbackAuthorization } from "@/server/transactions/service";

/**
 * No-vault checkout: PayPal sends the buyer back here after they approve the order.
 * We authorize it, then capture or hold exactly as the policy decision said.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const home = new URL("/", appBaseUrl(url.origin));
  const purchaseId = url.searchParams.get("purchase") ?? "";
  if (purchaseId) home.searchParams.set("purchase", purchaseId);
  try {
    const actor = requireUser(req);
    const r = await completeFallbackAuthorization(purchaseId, actor);
    home.searchParams.set("paypal", r.purchase.status.toLowerCase());
  } catch (e) {
    home.searchParams.set("paypal", "error");
    home.searchParams.set("message", e instanceof Error ? e.message.slice(0, 200) : "failed");
  }
  return Response.redirect(home, 303);
}

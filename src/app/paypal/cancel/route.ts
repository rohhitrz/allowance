import { requireUser } from "@/server/http/auth";
import { cancelFallbackPurchase } from "@/server/transactions/service";

/** No-vault checkout: the buyer cancelled in PayPal. Release the reservation right away. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const home = new URL("/", process.env.APP_BASE_URL ?? url.origin);
  const purchaseId = url.searchParams.get("purchase") ?? "";
  if (purchaseId) home.searchParams.set("purchase", purchaseId);
  try {
    const actor = requireUser(req);
    await cancelFallbackPurchase(purchaseId, actor);
    home.searchParams.set("paypal", "cancelled");
  } catch (e) {
    home.searchParams.set("paypal", "error");
    home.searchParams.set("message", e instanceof Error ? e.message.slice(0, 200) : "failed");
  }
  return Response.redirect(home, 303);
}

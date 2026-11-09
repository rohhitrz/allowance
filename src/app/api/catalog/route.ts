import { route, json, intParam } from "@/server/http/handler";
import { requireUser } from "@/server/http/auth";
import { searchCatalog } from "@/server/catalog/service";

export const GET = route(async (req) => {
  requireUser(req);
  const q = new URL(req.url).searchParams;
  return json({
    products: await searchCatalog({ query: q.get("q") ?? undefined, category: q.get("category") ?? undefined, maxPriceCents: intParam(q.get("maxPriceCents"), "maxPriceCents", { min: 1 }), limit: 50 }),
  });
});

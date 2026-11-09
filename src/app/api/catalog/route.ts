import { route, json } from "@/server/http/handler";
import { requireUser } from "@/server/http/auth";
import { searchCatalog } from "@/server/catalog/service";

export const GET = route(async (req) => {
  requireUser(req);
  const q = new URL(req.url).searchParams;
  const max = q.get("maxPriceCents");
  return json({
    products: await searchCatalog({ query: q.get("q") ?? undefined, category: q.get("category") ?? undefined, maxPriceCents: max ? Number(max) : undefined, limit: 50 }),
  });
});

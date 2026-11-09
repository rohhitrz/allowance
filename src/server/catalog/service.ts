import { and, desc, eq, ilike, lte, or, sql } from "drizzle-orm";
import { db } from "../db";
import { products } from "../db/schema";
import { AppError } from "../errors";

const STOP = new Set(["a", "an", "the", "for", "my", "of", "and", "or", "to", "with", "gift", "gifts"]);

export async function searchCatalog(opts: { query?: string; category?: string; maxPriceCents?: number; limit?: number }) {
  const words = (opts.query ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOP.has(w));
  const text = sql`(${products.name} || ' ' || ${products.blurb} || ' ' || ${products.category})`;
  const rows = await db()
    .select({
      id: products.id,
      name: products.name,
      category: products.category,
      priceCents: products.priceCents,
      rating: products.rating,
      blurb: products.blurb,
    })
    .from(products)
    .where(
      and(
        eq(products.active, true),
        opts.category ? eq(products.category, opts.category) : undefined,
        opts.maxPriceCents ? lte(products.priceCents, opts.maxPriceCents) : undefined,
        words.length ? or(...words.map((w) => ilike(text, `%${w}%`))) : undefined,
      ),
    )
    .orderBy(desc(products.rating), products.priceCents)
    .limit(opts.limit ?? 8);
  return rows;
}

/** Full product, including the UNTRUSTED description. */
export async function getProduct(productId: string) {
  const [p] = await db().select().from(products).where(eq(products.id, productId));
  if (!p || !p.active) throw new AppError("NOT_FOUND", `Unknown product ${productId}`);
  return p;
}

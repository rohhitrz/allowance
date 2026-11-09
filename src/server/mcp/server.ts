/**
 * MCP server (docs/03-api-design.md §7): any agent can get mandate-checked PayPal payments.
 * Agents propose; they can draft mandates and request purchases, never confirm or approve.
 * Stateless: one server + transport per HTTP request.
 */
import { appBaseUrl } from "../base-url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { apiClients, mandates } from "../db/schema";
import { AppError } from "../errors";
import { sha256 } from "../ids";
import { fmt } from "../money";
import { mandateOwnedBy } from "../app";
import { searchCatalog } from "../catalog/service";
import { DEMO_USER_ID, draftMandateFromText, getMandate, listMandates } from "../mandates/service";
import { purchaseMessage } from "../agent/runner";
import { getReceipt } from "../receipts";
import { freezeAll, requestPurchase } from "../transactions/service";

type Client = { id: string; name: string; actor: string };

/** Map the bearer key to an api_clients row (created on first use). */
export async function clientForKey(key: string): Promise<Client> {
  const hash = sha256(key);
  let [c] = await db().select().from(apiClients).where(eq(apiClients.keyHash, hash));
  if (!c) [c] = await db().insert(apiClients).values({ id: "cli_claude_desktop", name: "claude-desktop", keyHash: hash }).onConflictDoUpdate({ target: apiClients.id, set: { keyHash: hash } }).returning();
  if (c.revokedAt) throw new AppError("UNAUTHORIZED", "MCP key revoked");
  return { id: c.id, name: c.name, actor: `mcp:${c.name}` };
}

const text = (data: unknown) => ({ content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] });

async function ownedMandate(client: Client, mandateId: string) {
  const [m] = await db().select().from(mandates).where(eq(mandates.id, mandateId));
  if (!m || !mandateOwnedBy(m, client.id)) throw new AppError("NOT_FOUND", `Unknown mandate ${mandateId}`);
  return m;
}

function wrap<A>(fn: (args: A) => Promise<ReturnType<typeof text>>) {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (e) {
      const msg = e instanceof AppError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e);
      return { ...text(msg), isError: true };
    }
  };
}

export function buildMcpServer(client: Client) {
  const server = new McpServer({ name: "allowance", version: "0.1.0" });
  const base = appBaseUrl();

  server.registerTool(
    "create_mandate",
    {
      description: "Draft a spending mandate from plain words (budget, hard limit, categories, orders, deadline). It stays a DRAFT until a human confirms it in the Allowance dashboard; you cannot confirm it.",
      inputSchema: { text: z.string().min(3).max(2000) },
    },
    wrap(async ({ text: t }) => {
      const r = await draftMandateFromText({ text: t, actor: client.actor, apiClientId: client.id });
      return text({ mandateId: r.mandate.id, status: r.mandate.status, summary: r.summary, confirmUrl: `${base}/?mandate=${r.mandate.id}` });
    }),
  );

  server.registerTool(
    "list_mandates",
    { description: "Mandates you can spend from: the ones you created plus shared ones (e.g. Weekly groceries), with current spend." },
    wrap(async () => {
      const all = await listMandates();
      return text(
        all
          .filter((m) => mandateOwnedBy(m, client.id))
          .map((m) => ({ id: m.id, title: m.title, status: m.status, period: m.period, budget: fmt(m.budgetCents), hardLimit: fmt(m.hardLimitCents), spent: fmt(m.spend.amount.amountCents), orders: m.spend.orders })),
      );
    }),
  );

  server.registerTool(
    "get_mandate",
    { description: "One mandate's rules and current spend.", inputSchema: { mandateId: z.string() } },
    wrap(async ({ mandateId }) => {
      await ownedMandate(client, mandateId);
      const m = await getMandate(mandateId);
      return text({ id: m.id, title: m.title, brief: m.brief, status: m.status, version: m.version, rules: m.rules, spend: m.spend });
    }),
  );

  server.registerTool(
    "search_catalog",
    { description: "Search the store catalog.", inputSchema: { q: z.string(), maxPriceCents: z.number().int().positive().optional() } },
    wrap(async ({ q, maxPriceCents }) => {
      const rows = await searchCatalog({ query: q, maxPriceCents, limit: 10 });
      return text(rows.map((p) => ({ id: p.id, name: p.name, price: fmt(p.priceCents), priceCents: p.priceCents, category: p.category, rating: p.rating, blurb: p.blurb })));
    }),
  );

  server.registerTool(
    "request_purchase",
    {
      description:
        "Ask to buy a product from a mandate. Allowance checks every rule in code before any money moves, then pays with PayPal. Result: CAPTURED (bought), HELD (a human is asked; you cannot approve holds), BLOCKED (not allowed, PayPal never called) or FAILED. " +
        "Send a fresh idempotencyKey for each purchase you mean to make, and the same key when retrying it: a retry then returns the first result instead of buying again.",
      inputSchema: {
        mandateId: z.string(),
        productId: z.string(),
        quantity: z.number().int().min(1).max(1000),
        reason: z.string().max(500),
        idempotencyKey: z.string().min(8).max(200).optional(),
      },
    },
    wrap(async ({ mandateId, productId, quantity, reason, idempotencyKey }) => {
      await ownedMandate(client, mandateId);
      // Keys are scoped to this client, so one client's key can never return another's purchase.
      const key = idempotencyKey ? `${client.actor}:${idempotencyKey}` : undefined;
      const r = await requestPurchase({ mandateId, productId, quantity, reason, actor: client.actor, idempotencyKey: key });
      const receipt = await getReceipt(r.purchase.id);
      return text({ purchaseId: r.purchase.id, status: r.purchase.status, message: purchaseMessage(r), receiptSummary: receipt.summary, ruleResults: receipt.ruleResults });
    }),
  );

  server.registerTool(
    "get_receipt",
    { description: "The decision receipt for a purchase attempt: every rule result, the PayPal state and the timeline.", inputSchema: { purchaseId: z.string() } },
    wrap(async ({ purchaseId }) => {
      const r = await getReceipt(purchaseId);
      await ownedMandate(client, r.purchase.mandateId);
      return text({ summary: r.summary, status: r.purchase.status, ruleResults: r.ruleResults, timeline: r.timeline.map((e) => ({ at: e.at, actor: e.actor, type: e.type })) });
    }),
  );

  server.registerTool(
    "freeze_all",
    { description: "Kill switch: freeze every active mandate and void open holds. Always allowed, because freezing is the safe direction. Only a human can unfreeze." },
    wrap(async () => text(await freezeAll({ actor: client.actor, userId: DEMO_USER_ID }))),
  );

  return server;
}

export async function handleMcp(req: Request, client: Client) {
  const server = buildMcpServer(client);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    // Stateless: the JSON response is complete once handleRequest resolves.
    void server.close();
  }
}

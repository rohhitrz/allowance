# Allowance — API Design

v1 · Nov 9, 2026 · Rohit Raaj (solo) · Status: **draft, awaiting approval**
Builds on: [01-PRD.md](01-PRD.md), [02-system-design.md](02-system-design.md)

## 1. Summary

Allowance has four API surfaces, and all of them call the same service functions:

| Surface | Path | Caller | Auth |
| --- | --- | --- | --- |
| REST | `/api/*` | Dashboard (and curl / tests) | Session cookie |
| Voice tools | `/api/voice/tools` | Vapi | `x-vapi-secret` header |
| MCP | `/api/mcp` | External agents (Claude Desktop, etc.) | `Authorization: Bearer <MCP_API_KEY>` |
| Agent tools | in-process (no HTTP) | Allowance's own shopping agent | Internal |

**The key rule: agents can propose, only humans can commit.** An agent (ours or an MCP client) can draft a mandate and request a purchase. Only a human, through the dashboard or voice, can confirm a mandate, approve a hold or unfreeze. The table in §3 enforces this in code.

## 2. Conventions

- JSON in and out; `camelCase` fields; IDs are prefixed strings (`man_…`, `pur_…`, `apr_…`, `prd_…`, `evt_…`, `run_…`).
- **Money** is always integer cents plus currency: `{ "amountCents": 8999, "currency": "USD" }`. Only USD.
- **Times** are ISO 8601 UTC strings. A mandate has its own `timezone` (default `Asia/Kolkata`) for period windows.
- **Idempotency:** `POST` endpoints that move money (`/purchases`, `/approvals/:token/decision`, `/purchases/:id/refund`) accept an `Idempotency-Key` header. A repeated key returns the first result.
- **Policy outcomes are not errors.** A blocked purchase returns `201` with `status: "BLOCKED"` and its receipt. HTTP errors are for bad input, wrong state, auth or PayPal failures.

**Error shape**

```json
{ "error": { "code": "INVALID_STATE", "message": "Mandate is FROZEN", "details": {} } }
```

| HTTP | code | When |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | Body fails zod schema |
| 401 | `UNAUTHORIZED` | Missing or bad cookie, secret or key |
| 403 | `FORBIDDEN_FOR_ACTOR` | e.g. an MCP agent trying to approve a hold |
| 404 | `NOT_FOUND` | Unknown ID or token |
| 409 | `INVALID_STATE` | Action not allowed in current status |
| 410 | `APPROVAL_EXPIRED` | Approval token past `expiresAt` or already used |
| 422 | `PARSE_FAILED` | Claude couldn't turn the text into a valid mandate |
| 502 | `PAYPAL_ERROR` | PayPal call failed; `details.paypalDebugId` included |

## 3. Actor permissions

| Action | Dashboard user | Voice (user) | MCP agent | Allowance agent |
| --- | --- | --- | --- | --- |
| Draft a mandate | ✅ | ✅ | ✅ | — |
| Confirm, edit draft, cancel | ✅ | ✅ | ❌ | ❌ |
| Request a purchase | ✅ (debug) | ❌ | ✅ | ✅ |
| Approve / reject a hold | ✅ | ✅ | ❌ | ❌ |
| Freeze all (kill switch) | ✅ | ✅ | ✅ (safe direction) | ❌ |
| Unfreeze | ✅ | ✅ | ❌ | ❌ |
| Refund (P1) | ✅ | ✅ | ❌ | ❌ |
| Read mandates, receipts, activity | ✅ | ✅ | ✅ own mandates only | ✅ its mandate only |

Every request resolves to an `actor` (`user:dashboard`, `user:voice`, `mcp:<clientName>`, `agent:allowance`). The actor is recorded on every event and receipt.

## 4. Core types

```ts
type Money = { amountCents: number; currency: "USD" };

type MandateRules = {
  budget: Money;                 // soft: over it → HOLD
  hardLimit: Money;              // hard: over it → BLOCK
  perItemMax?: Money;            // hard
  allowedCategories?: string[];  // soft
  blockedCategories: string[];   // hard; always includes gift_cards, crypto, cash_equivalents
  maxOrders: number;             // hard, per period
  maxQuantity: number;           // hard, per order
  noDuplicates: boolean;         // hard
  period: "once" | "weekly" | "monthly";
  expiresAt?: string;            // hard; required for "once"
  timezone: string;
};

type Mandate = {
  id: string; title: string; brief: string;       // brief = what the user asked for, shown to the agent
  status: "DRAFT" | "ACTIVE" | "FROZEN" | "EXPIRED" | "CANCELLED";
  version: number; rules: MandateRules;
  spend: { amount: Money; orders: number; periodStart: string; periodEnd: string | null };
  createdBy: string; createdAt: string;
};

type RuleResult = { rule: string; kind: "hard" | "soft"; passed: boolean; detail: string };

type Purchase = {
  id: string; mandateId: string; mandateVersion: number;
  product: { id: string; name: string; category: string; price: Money };
  quantity: number; total: Money; reason: string; requestedBy: string;
  decision: "APPROVE" | "HOLD" | "BLOCK";
  status: "PROPOSED" | "BLOCKED" | "RESERVED" | "AUTHORIZED" | "HELD" | "CAPTURED" | "VOIDED" | "FAILED" | "REFUNDED";
  paypal: { orderId?: string; authorizationId?: string; captureId?: string; refundId?: string; called: boolean };
  approvalId?: string; createdAt: string; updatedAt: string;
};

type Receipt = {
  purchase: Purchase;
  mandateSnapshot: { version: number; rules: MandateRules };   // the rules as they were when checked
  ruleResults: RuleResult[];                                  // every rule, in order
  timeline: Event[];                                          // every state change
  summary: string;   // template text, e.g. "Blocked: gift_cards is a blocked category. PayPal was never called."
};

type Approval = {
  id: string; token: string; purchaseId: string; amount: Money; mandateVersion: number;
  softRulesFailed: RuleResult[]; prompt: string;            // fixed text the voice reads out
  status: "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED" | "CANCELLED";
  expiresAt: string; decidedBy?: string;
};

type Event = {
  id: string; at: string; actor: string;
  type: string;            // e.g. "purchase.blocked", "mandate.frozen"
  mandateId?: string; purchaseId?: string; data: Record<string, unknown>;
};
```

## 5. REST endpoints

### 5.1 Session and health

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| POST | `/api/session` | `{ passcode }` | `204` + signed httpOnly cookie |
| DELETE | `/api/session` | — | `204` |
| GET | `/api/health` | — | `{ ok: true, db: "up", paypal: "configured" }` |

### 5.2 Mandates

| Method | Path | Body | Returns | Notes |
| --- | --- | --- | --- | --- |
| POST | `/api/mandates` | `{ text }` | `201 { mandate, summary }` | Claude parses the text; saved as DRAFT; `summary` is the read-back sentence |
| PATCH | `/api/mandates/:id` | partial `MandateRules`, `title` | `200 { mandate, summary }` | DRAFT only; locked blocked categories can't be removed |
| POST | `/api/mandates/:id/confirm` | `{ startAgent?: true }` | `200 { mandate, run? }` | DRAFT → ACTIVE (v1); starts the shopping agent by default |
| POST | `/api/mandates/:id/cancel` | — | `200 { mandate }` | Voids any open holds |
| POST | `/api/mandates/:id/unfreeze` | — | `200 { mandate }` | FROZEN → ACTIVE, `version + 1` |
| GET | `/api/mandates` | `?status=` | `{ mandates: Mandate[] }` | Includes `spend` for the current period |
| GET | `/api/mandates/:id` | — | `{ mandate, purchases: Purchase[] }` | |
| POST | `/api/freeze-all` | — | `200 { frozen: number, voided: number }` | Kill switch |

**Example: create**

```http
POST /api/mandates
{ "text": "Find a birthday gift for my sister, around $150, never more than $200, no gift cards, one purchase, by Friday" }
```
```json
{
  "mandate": {
    "id": "man_7f3k", "title": "Birthday gift for sister", "status": "DRAFT", "version": 0,
    "rules": {
      "budget": { "amountCents": 15000, "currency": "USD" },
      "hardLimit": { "amountCents": 20000, "currency": "USD" },
      "blockedCategories": ["gift_cards", "crypto", "cash_equivalents"],
      "allowedCategories": ["gifts", "electronics", "books", "home"],
      "maxOrders": 1, "maxQuantity": 1, "noDuplicates": true,
      "period": "once", "expiresAt": "2026-11-13T18:29:59Z", "timezone": "Asia/Kolkata"
    }
  },
  "summary": "Birthday gift for your sister: aim for $150, never more than $200, one purchase, no gift cards, until Friday 13 November. Should I start?"
}
```

### 5.3 Shopping agent runs

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| POST | `/api/mandates/:id/runs` | `{ brief? }` | `202 { run }` |
| GET | `/api/runs/:id` | — | `{ run: { id, status, steps: [{ tool, input, output, at }] } }` |
| POST | `/api/runs/:id/stop` | — | `200 { run }` |

`run.status`: `RUNNING | WAITING_APPROVAL | DONE | STOPPED | FAILED`. A run pauses on a hold and resumes when the approval is decided.

### 5.4 Purchases and receipts

| Method | Path | Body | Returns | Notes |
| --- | --- | --- | --- | --- |
| POST | `/api/purchases` | `{ mandateId, productId, quantity, reason }` | `201 { purchase, receipt, approval? }` | The one money entry point. Status is BLOCKED, CAPTURED, HELD or FAILED by the time it returns |
| GET | `/api/purchases` | `?mandateId=&status=` | `{ purchases }` | |
| GET | `/api/purchases/:id/receipt` | — | `{ receipt }` | The decision receipt |
| POST | `/api/purchases/:id/refund` | `{ reason? }` | `200 { purchase }` | P1; CAPTURED only |

**Example: blocked injection attempt**

```json
{
  "purchase": { "id": "pur_9x2", "status": "BLOCKED", "decision": "BLOCK",
    "product": { "id": "prd_gc100", "name": "Digital Gift Card $100", "category": "gift_cards",
                 "price": { "amountCents": 10000, "currency": "USD" } },
    "quantity": 5, "total": { "amountCents": 50000, "currency": "USD" },
    "paypal": { "called": false } },
  "receipt": {
    "ruleResults": [
      { "rule": "mandate_active",   "kind": "hard", "passed": true,  "detail": "ACTIVE" },
      { "rule": "hard_limit",       "kind": "hard", "passed": false, "detail": "$500.00 + $89.99 spent > $200.00 limit" },
      { "rule": "blocked_category", "kind": "hard", "passed": false, "detail": "gift_cards is blocked" },
      { "rule": "max_orders",       "kind": "hard", "passed": false, "detail": "1 of 1 orders already used" },
      { "rule": "max_quantity",     "kind": "hard", "passed": false, "detail": "5 > 1" },
      { "rule": "budget",           "kind": "soft", "passed": false, "detail": "over $150.00 budget" }
    ],
    "summary": "Blocked by 4 hard rules. PayPal was never called."
  }
}
```

### 5.5 Approvals

| Method | Path | Body | Returns | Notes |
| --- | --- | --- | --- | --- |
| GET | `/api/approvals` | `?status=PENDING` | `{ approvals }` | |
| POST | `/api/approvals/:token/decision` | `{ decision: "approve" \| "reject" }` | `200 { approval, purchase }` | Human actors only. Approve re-checks, then captures; else voids. Token is single use |

### 5.6 Catalog

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/api/catalog` | `?q=&category=&maxPriceCents=` → `{ products }` |
| GET | `/api/catalog/:id` | `{ product }` (includes `description`, which may be poisoned) |

### 5.7 Activity feed

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/api/events` | `?since=&mandateId=&limit=` → `{ events }` |
| GET | `/api/events/stream` | SSE: `event: <type>`, `data: Event`; heartbeat every 15 s; client reconnects with `Last-Event-ID` |

### 5.8 PayPal

| Method | Path | Returns | Notes |
| --- | --- | --- | --- |
| POST | `/api/paypal/vault/setup` | `{ approveUrl }` | Creates a Vault setup token; open in a popup |
| GET | `/api/paypal/vault/return` | redirect to `/` | PayPal redirects here; we exchange the setup token for a payment token and store it |
| GET | `/api/paypal/vault` | `{ linked: boolean, payerEmail? }` | Shown on the dashboard |
| POST | `/api/purchases/:id/authorize` | `{ purchase }` | **No-vault fallback only:** called after the buyer approves the popup |
| POST | `/api/paypal/webhook` | `200` | P2; verified with PayPal's signature API |

In fallback mode, `POST /api/purchases` returns `status: "RESERVED"` with `paypal.approveUrl`. The UI opens it, then calls `/authorize`. The rest of the flow is the same.

### 5.9 Demo (only when `DEMO_MODE=true`)

| Method | Path | Does |
| --- | --- | --- |
| POST | `/api/demo/reset` | Wipes mandates, purchases and events; re-seeds the catalog and the grocery mandate |
| POST | `/api/demo/script` | `{ step }` runs one scripted demo beat with a fixed agent path (backup if the live agent misbehaves on camera) |

## 6. Voice tools (Vapi)

`POST /api/voice/tools`, called by Vapi for each tool the assistant uses. It requires `x-vapi-secret`. We read the tool calls from the request and reply with one result per call. **The exact Vapi payload shape gets checked against their docs on day 1. The handler is a thin adapter, so only that file changes.**

| Tool | Args | Result (spoken by the assistant) |
| --- | --- | --- |
| `create_mandate` | `{ text }` | `{ mandateId, summary }` |
| `confirm_mandate` | `{ mandateId }` | `{ status, message: "Done. I'm shopping now." }` |
| `list_activity` | `{ limit? }` | `{ items: [{ when, what, status, why }] }` as short sentences |
| `get_pending_approval` | — | `{ token, prompt }` or `{ none: true }` |
| `decide_approval` | `{ token, decision }` | `{ status, message }` |
| `freeze_all` | — | `{ message: "Stopped. 1 mandate frozen, 1 hold voided." }` |
| `refund` | `{ purchaseId }` | `{ message }` (P1) |

Voice rules in the handler, not in the prompt:
- `decide_approval` accepts only the exact strings `approve` or `reject`. The assistant is instructed to send `reject` when the answer is unclear.
- The prompt text read to the user comes from `approval.prompt`, generated by a template, never by the model.

Fallback: `POST /api/voice/local` with `{ tool, args }` from the browser speech UI. Same handlers, cookie auth.

## 7. MCP server

Streamable HTTP at `/api/mcp`, built with `@modelcontextprotocol/sdk`, bearer key auth. The tool descriptions tell the calling agent the rules of the road. For example, `request_purchase` says: "You cannot approve holds; a human will be asked."

| Tool | Input | Output |
| --- | --- | --- |
| `create_mandate` | `{ text }` | `{ mandateId, status: "DRAFT", summary, confirmUrl }`. A human must confirm in the dashboard |
| `list_mandates` | — | Mandates created by this client, plus seeded shared ones (the grocery mandate) |
| `get_mandate` | `{ mandateId }` | Rules + current spend |
| `search_catalog` | `{ q, maxPriceCents? }` | Products |
| `request_purchase` | `{ mandateId, productId, quantity, reason }` | `{ status, receiptSummary, ruleResults }` |
| `get_receipt` | `{ purchaseId }` | Receipt |
| `freeze_all` | — | Counts |

## 8. Internal agent tools

These are passed to Claude in the agent runner and executed in-process against the same services:

| Tool | Input | Output to the model |
| --- | --- | --- |
| `search_catalog` | `{ query, maxPriceCents? }` | Up to 8 products: id, name, price, category, rating, one-line blurb |
| `get_product` | `{ productId }` | Full product including `description` (untrusted; may contain the injection) |
| `request_purchase` | `{ productId, quantity, reason }` | `{ status, message }`, e.g. "HELD: waiting for the user (over $150 budget)" or "BLOCKED: gift_cards is blocked, max_quantity exceeded" |

The `mandateId` is bound by the runner, so the model can't spend from another mandate.

## 9. Live event types

`mandate.drafted`, `mandate.confirmed`, `mandate.frozen`, `mandate.unfrozen`, `mandate.cancelled`, `mandate.expired`, `run.started`, `run.step`, `run.waiting`, `run.finished`, `purchase.proposed`, `purchase.blocked`, `purchase.reserved`, `purchase.authorized`, `purchase.held`, `purchase.captured`, `purchase.voided`, `purchase.failed`, `purchase.refunded`, `approval.created`, `approval.decided`, `approval.expired`, `vault.linked`.

The dashboard listens on `/api/events/stream`. The feed shows a card per purchase that updates in place, and an approval card pops up on `approval.created`.

## 10. Decisions to approve

| ID | Decision | Recommendation |
| --- | --- | --- |
| A1 | Who can commit | Agents propose; only humans confirm mandates, approve holds, unfreeze and refund |
| A2 | MCP agents and the kill switch | Allowed, because freezing is always the safe direction |
| A3 | Blocked = success response | `201` with `status: BLOCKED`, not an HTTP error, so callers always get a receipt |
| A4 | Demo backup | `/api/demo/script` runs a fixed agent path if the live model misbehaves on camera |
| A5 | Default timezone | `Asia/Kolkata` for weekly and monthly windows and expiry |

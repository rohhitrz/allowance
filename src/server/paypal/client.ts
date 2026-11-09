/**
 * Minimal PayPal REST client (sandbox by default).
 *
 * Only the transaction service may call the write methods here.
 * Every write sends a PayPal-Request-Id so retries are idempotent.
 * Env vars are read at call time so scripts can load .env after import.
 */

export class PayPalError extends Error {
  constructor(
    message: string,
    public status: number,
    public debugId?: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = "PayPalError";
  }
}

type Link = { href: string; rel: string; method?: string };

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

function baseUrl(): string {
  return process.env.PAYPAL_API_BASE ?? "https://api-m.sandbox.paypal.com";
}

export function centsToValue(cents: number): string {
  if (!Number.isInteger(cents) || cents <= 0) throw new Error(`Bad amount: ${cents}`);
  return (cents / 100).toFixed(2);
}

let cachedToken: { token: string; expiresAt: number } | null = null;

async function accessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.token;
  const basic = Buffer.from(`${env("PAYPAL_CLIENT_ID")}:${env("PAYPAL_CLIENT_SECRET")}`).toString("base64");
  const res = await fetch(`${baseUrl()}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  const json = (await res.json()) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!res.ok || !json.access_token) {
    throw new PayPalError(`OAuth failed: ${json.error_description ?? res.statusText}`, res.status);
  }
  cachedToken = { token: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 300) * 1000 };
  return cachedToken.token;
}

async function request<T>(
  method: "GET" | "POST",
  path: string,
  opts: { body?: unknown; requestId?: string } = {},
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${await accessToken()}`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  };
  if (opts.requestId) headers["PayPal-Request-Id"] = opts.requestId;

  const res = await fetch(`${baseUrl()}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const debugId = res.headers.get("paypal-debug-id") ?? json.debug_id;
    const detail = json.details?.[0]?.issue ?? json.name ?? res.statusText;
    throw new PayPalError(`${method} ${path} failed (${res.status}): ${detail}`, res.status, debugId, json);
  }
  return json as T;
}

function link(links: Link[] | undefined, rel: string): string | undefined {
  return links?.find((l) => l.rel === rel)?.href;
}

// ---------- Vault v3: save the buyer's PayPal once ----------

export async function createVaultSetupToken(args: { returnUrl: string; cancelUrl: string; requestId: string }) {
  const res = await request<{ id: string; status: string; links?: Link[] }>("POST", "/v3/vault/setup-tokens", {
    requestId: args.requestId,
    body: {
      payment_source: {
        paypal: {
          description: "Allowance: let your AI agent pay within your spending mandates",
          usage_pattern: "IMMEDIATE",
          usage_type: "MERCHANT",
          customer_type: "CONSUMER",
          permit_multiple_payment_tokens: false,
          experience_context: {
            brand_name: "Allowance",
            shipping_preference: "NO_SHIPPING",
            return_url: args.returnUrl,
            cancel_url: args.cancelUrl,
          },
        },
      },
    },
  });
  return { setupTokenId: res.id, status: res.status, approveUrl: link(res.links, "approve") };
}

export async function createVaultPaymentToken(args: { setupTokenId: string; requestId: string }) {
  const res = await request<{
    id: string;
    customer?: { id: string };
    payment_source?: { paypal?: { email_address?: string; payer_id?: string } };
  }>("POST", "/v3/vault/payment-tokens", {
    requestId: args.requestId,
    body: { payment_source: { token: { id: args.setupTokenId, type: "SETUP_TOKEN" } } },
  });
  return {
    vaultId: res.id,
    customerId: res.customer?.id,
    payerEmail: res.payment_source?.paypal?.email_address,
    payerId: res.payment_source?.paypal?.payer_id,
  };
}

// ---------- Orders v2 + Payments v2 ----------

type OrderResponse = {
  id: string;
  status: string;
  links?: Link[];
  purchase_units?: { payments?: { authorizations?: { id: string; status: string }[] } }[];
};

function firstAuthorization(order: OrderResponse) {
  return order.purchase_units?.[0]?.payments?.authorizations?.[0];
}

/** Authorize directly against a vaulted PayPal account (no buyer interaction). */
export async function authorizeWithVault(args: {
  amountCents: number;
  vaultId: string;
  description: string;
  customId: string; // our purchase id
  requestId: string;
}) {
  const order = await request<OrderResponse>("POST", "/v2/checkout/orders", {
    requestId: args.requestId,
    body: {
      intent: "AUTHORIZE",
      purchase_units: [
        {
          custom_id: args.customId,
          description: args.description.slice(0, 127),
          amount: { currency_code: "USD", value: centsToValue(args.amountCents) },
        },
      ],
      payment_source: { paypal: { vault_id: args.vaultId } },
    },
  });
  const auth = firstAuthorization(order);
  return { orderId: order.id, orderStatus: order.status, authorizationId: auth?.id, authorizationStatus: auth?.status };
}

/** No-vault fallback: create an order the buyer must approve in a popup. */
export async function createOrderForApproval(args: {
  amountCents: number;
  description: string;
  customId: string;
  returnUrl: string;
  cancelUrl: string;
  requestId: string;
}) {
  const order = await request<OrderResponse>("POST", "/v2/checkout/orders", {
    requestId: args.requestId,
    body: {
      intent: "AUTHORIZE",
      purchase_units: [
        {
          custom_id: args.customId,
          description: args.description.slice(0, 127),
          amount: { currency_code: "USD", value: centsToValue(args.amountCents) },
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: "Allowance",
            shipping_preference: "NO_SHIPPING",
            user_action: "CONTINUE",
            return_url: args.returnUrl,
            cancel_url: args.cancelUrl,
          },
        },
      },
    },
  });
  return { orderId: order.id, approveUrl: link(order.links, "payer-action") ?? link(order.links, "approve") };
}

/** No-vault fallback: authorize after the buyer approved. */
export async function authorizeOrder(args: { orderId: string; requestId: string }) {
  const order = await request<OrderResponse>("POST", `/v2/checkout/orders/${args.orderId}/authorize`, {
    requestId: args.requestId,
    body: {},
  });
  const auth = firstAuthorization(order);
  return { orderId: order.id, authorizationId: auth?.id, authorizationStatus: auth?.status };
}

export async function captureAuthorization(args: { authorizationId: string; requestId: string }) {
  const res = await request<{ id: string; status: string }>(
    "POST",
    `/v2/payments/authorizations/${args.authorizationId}/capture`,
    { requestId: args.requestId, body: { final_capture: true } },
  );
  return { captureId: res.id, status: res.status };
}

export async function voidAuthorization(args: { authorizationId: string; requestId: string }) {
  const res = await request<{ id?: string; status?: string }>(
    "POST",
    `/v2/payments/authorizations/${args.authorizationId}/void`,
    { requestId: args.requestId },
  );
  return { status: res.status ?? "VOIDED" };
}

export async function refundCapture(args: { captureId: string; requestId: string; note?: string }) {
  const res = await request<{ id: string; status: string }>("POST", `/v2/payments/captures/${args.captureId}/refund`, {
    requestId: args.requestId,
    body: args.note ? { note_to_payer: args.note.slice(0, 255) } : {},
  });
  return { refundId: res.id, status: res.status };
}

export async function getAuthorization(authorizationId: string) {
  return request<{ id: string; status: string; amount: { value: string } }>(
    "GET",
    `/v2/payments/authorizations/${authorizationId}`,
  );
}

/**
 * PayPal sandbox spike: proves the payment assumptions in docs/02-system-design.md §7.
 *
 *   npm run spike -- check      OAuth works with your sandbox keys
 *   npm run spike -- setup      create a Vault setup token, prints a URL to approve as the sandbox BUYER
 *   npm run spike -- token      exchange the approved setup token for a vault id (payment token)
 *   npm run spike -- run        the demo money paths using the vault id:
 *                                 A) $89.99 authorize -> capture -> refund
 *                                 B) $170.00 authorize -> void
 *   npm run spike -- fallback   no-vault path: creates an order and prints the buyer approve URL
 *   npm run spike -- fallback-auth <orderId>   authorize + capture after you approved it
 *
 * State (setup token, vault id) is kept in .spike-state.json (gitignored).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  authorizeOrder,
  authorizeWithVault,
  captureAuthorization,
  createOrderForApproval,
  createVaultPaymentToken,
  createVaultSetupToken,
  getAuthorization,
  PayPalError,
  refundCapture,
  voidAuthorization,
} from "../src/server/paypal/client";

if (existsSync(".env")) process.loadEnvFile(".env");

const STATE_FILE = ".spike-state.json";
type State = { setupTokenId?: string; vaultId?: string; payerEmail?: string };
const load = (): State => (existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {});
const save = (s: State) => writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));

const RETURN_URL = "https://example.com/allowance/return";
const CANCEL_URL = "https://example.com/allowance/cancel";
const rid = (label: string) => `spike-${label}-${randomUUID()}`;

function ok(msg: string) {
  console.log(`  ✓ ${msg}`);
}

async function check() {
  // Any authenticated call proves OAuth; a bogus authorization id should 404, not 401.
  try {
    await getAuthorization("SPIKE-DOES-NOT-EXIST");
  } catch (e) {
    if (e instanceof PayPalError && (e.status === 404 || e.status === 400 || e.status === 422)) {
      ok(`OAuth works (API answered ${e.status} for a fake id, as expected)`);
      return;
    }
    throw e;
  }
}

async function setup() {
  const r = await createVaultSetupToken({ returnUrl: RETURN_URL, cancelUrl: CANCEL_URL, requestId: rid("setup") });
  save({ ...load(), setupTokenId: r.setupTokenId, vaultId: undefined });
  ok(`setup token ${r.setupTokenId} (${r.status})`);
  console.log(`\n  Open this URL, log in as your SANDBOX PERSONAL (buyer) account and approve:\n\n  ${r.approveUrl}\n`);
  console.log("  You'll land on example.com afterwards; that's expected. Then run: npm run spike -- token\n");
}

async function token() {
  const s = load();
  if (!s.setupTokenId) throw new Error("Run `setup` first");
  const r = await createVaultPaymentToken({ setupTokenId: s.setupTokenId, requestId: rid("token") });
  save({ ...s, vaultId: r.vaultId, payerEmail: r.payerEmail });
  ok(`vault id ${r.vaultId} for ${r.payerEmail ?? "unknown payer"} (customer ${r.customerId ?? "?"})`);
}

async function run() {
  const s = load();
  if (!s.vaultId) throw new Error("No vault id yet: run `setup`, approve, then `token`");

  console.log("\n  A) $89.99 gift: authorize -> capture -> refund");
  const a = await authorizeWithVault({
    amountCents: 8999,
    vaultId: s.vaultId,
    description: "Hand-Poured Candle & Journal Gift Set",
    customId: "pur_spike_a",
    requestId: rid("a-auth"),
  });
  ok(`order ${a.orderId} ${a.orderStatus}, authorization ${a.authorizationId} ${a.authorizationStatus}`);
  if (!a.authorizationId) throw new Error("No authorization returned: vault-authorize assumption FAILED");
  const cap = await captureAuthorization({ authorizationId: a.authorizationId, requestId: rid("a-cap") });
  ok(`capture ${cap.captureId} ${cap.status}`);
  const ref = await refundCapture({ captureId: cap.captureId, requestId: rid("a-ref"), note: "Allowance spike refund" });
  ok(`refund ${ref.refundId} ${ref.status}`);

  console.log("\n  B) $170 headphones: authorize -> void (user rejected)");
  const b = await authorizeWithVault({
    amountCents: 17000,
    vaultId: s.vaultId,
    description: "Premium Noise-Cancelling Headphones",
    customId: "pur_spike_b",
    requestId: rid("b-auth"),
  });
  ok(`order ${b.orderId} ${b.orderStatus}, authorization ${b.authorizationId} ${b.authorizationStatus}`);
  if (!b.authorizationId) throw new Error("No authorization returned for B");
  const v = await voidAuthorization({ authorizationId: b.authorizationId, requestId: rid("b-void") });
  ok(`void ${v.status}`);
  const after = await getAuthorization(b.authorizationId);
  ok(`authorization ${after.id} now ${after.status}`);

  console.log("\n  SPIKE PASSED: vault authorize, capture, void and refund all work.\n");
}

async function fallback() {
  const r = await createOrderForApproval({
    amountCents: 8999,
    description: "Hand-Poured Candle & Journal Gift Set",
    customId: "pur_spike_fb",
    returnUrl: RETURN_URL,
    cancelUrl: CANCEL_URL,
    requestId: rid("fb-order"),
  });
  ok(`order ${r.orderId}`);
  console.log(`\n  Approve as the sandbox buyer:\n\n  ${r.approveUrl}\n\n  Then: npm run spike -- fallback-auth ${r.orderId}\n`);
}

async function fallbackAuth(orderId: string | undefined) {
  if (!orderId) throw new Error("Usage: fallback-auth <orderId>");
  const a = await authorizeOrder({ orderId, requestId: rid("fb-auth") });
  ok(`authorization ${a.authorizationId} ${a.authorizationStatus}`);
  if (!a.authorizationId) throw new Error("No authorization returned");
  const cap = await captureAuthorization({ authorizationId: a.authorizationId, requestId: rid("fb-cap") });
  ok(`capture ${cap.captureId} ${cap.status}`);
}

const [cmd, arg] = process.argv.slice(2);
const commands: Record<string, () => Promise<void>> = {
  check,
  setup,
  token,
  run,
  fallback,
  "fallback-auth": () => fallbackAuth(arg),
};

const fn = commands[cmd ?? ""];
if (!fn) {
  console.log("Usage: npm run spike -- <check|setup|token|run|fallback|fallback-auth <orderId>>");
  process.exit(1);
}
fn().catch((e) => {
  if (e instanceof PayPalError) {
    console.error(`\n  ✗ ${e.message}\n    debug id: ${e.debugId}\n    details: ${JSON.stringify(e.details, null, 2)}`);
  } else {
    console.error(`\n  ✗ ${e instanceof Error ? e.message : e}`);
  }
  process.exit(1);
});

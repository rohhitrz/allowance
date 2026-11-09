/** Link the buyer's PayPal once (Vault v3), so later authorizations need no popup. */
import { appBaseUrl } from "../base-url";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { paypalVaults } from "../db/schema";
import { AppError, assertHuman } from "../errors";
import { recordEvent } from "../events/bus";
import { id } from "../ids";
import { DEMO_USER_ID } from "../mandates/service";
import { createVaultPaymentToken, createVaultSetupToken, PayPalError } from "./client";

const base = () => appBaseUrl();

export async function startVaultSetup(actor: string, userId = DEMO_USER_ID) {
  assertHuman(actor);
  const vid = id("vlt");
  const r = await createVaultSetupToken({
    returnUrl: `${base()}/api/paypal/vault/return`,
    cancelUrl: `${base()}/?vault=cancelled`,
    requestId: `${vid}:setup`,
  });
  if (!r.approveUrl) throw new AppError("PAYPAL_ERROR", "PayPal returned no approve link");
  await db().insert(paypalVaults).values({ id: vid, userId, setupTokenId: r.setupTokenId, status: "PENDING" });
  return { approveUrl: r.approveUrl };
}

/** PayPal redirects back with approval_token_id = the setup token we created. */
export async function finishVaultSetup(setupTokenId: string, userId = DEMO_USER_ID) {
  const [pending] = await db()
    .select()
    .from(paypalVaults)
    .where(and(eq(paypalVaults.setupTokenId, setupTokenId), eq(paypalVaults.status, "PENDING")));
  if (!pending) throw new AppError("NOT_FOUND", "Unknown or already used setup token");
  let token;
  try {
    token = await createVaultPaymentToken({ setupTokenId, requestId: `${pending.id}:token` });
  } catch (e) {
    throw new AppError("PAYPAL_ERROR", e instanceof Error ? e.message : String(e), {
      paypalDebugId: e instanceof PayPalError ? e.debugId : undefined,
    });
  }
  await db().transaction(async (tx) => {
    await tx
      .update(paypalVaults)
      .set({ status: "REVOKED", updatedAt: new Date() })
      .where(and(eq(paypalVaults.userId, userId), eq(paypalVaults.status, "ACTIVE")));
    await tx
      .update(paypalVaults)
      .set({ status: "ACTIVE", paymentTokenId: token.vaultId, payerId: token.payerId ?? null, payerEmail: token.payerEmail ?? null, updatedAt: new Date() })
      .where(eq(paypalVaults.id, pending.id));
    await recordEvent(tx, { actor: "user:dashboard", type: "vault.linked", data: { payerEmail: token.payerEmail ?? null } });
  });
  return { payerEmail: token.payerEmail };
}

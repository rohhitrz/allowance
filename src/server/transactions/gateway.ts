/**
 * The PayPal surface the transaction service uses (writes, plus the reads it reconciles with). Swappable so tests
 * can run the state machine without the sandbox. Nothing else imports this.
 */
import * as paypal from "../paypal/client";

export type PaymentGateway = Pick<
  typeof paypal,
  | "authorizeWithVault"
  | "createOrderForApproval"
  | "authorizeOrder"
  | "captureAuthorization"
  | "voidAuthorization"
  | "refundCapture"
  | "getAuthorization"
  | "getOrderCaptures"
  | "getOrderAuthorizations"
  | "getCapture"
  | "getRefund"
>;

let current: PaymentGateway = paypal;

export const gateway = () => current;

/** Tests only. */
export function setGateway(g: PaymentGateway | null) {
  current = g ?? paypal;
}

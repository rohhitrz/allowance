/** Row -> API shape (docs/03-api-design.md §4). Money is always { amountCents, currency }. */
import type { ApprovalRow, PurchaseRow } from "./db/schema";
import { usd } from "./money";
import { failedRules } from "./policy/engine";
import { receiptSummary } from "./receipts";

export function purchaseDto(p: PurchaseRow, approvalId?: string | null) {
  return {
    id: p.id,
    mandateId: p.mandateId,
    mandateVersion: p.mandateVersion,
    runId: p.runId,
    product: { id: p.productId, name: p.productName, category: p.productCategory, price: usd(p.unitPriceCents) },
    quantity: p.quantity,
    total: usd(p.totalCents),
    reason: p.reason,
    requestedBy: p.requestedBy,
    decision: p.decision,
    status: p.status,
    failedRules: failedRules(p.ruleResults).map((r) => ({ rule: r.rule, kind: r.kind, detail: r.detail })),
    ruleResults: p.ruleResults,
    paypal: {
      called: p.paypalCalled,
      orderId: p.paypalOrderId ?? undefined,
      authorizationId: p.paypalAuthorizationId ?? undefined,
      captureId: p.paypalCaptureId ?? undefined,
      refundId: p.paypalRefundId ?? undefined,
      approveUrl: p.paypalApproveUrl ?? undefined,
      debugId: p.paypalDebugId ?? undefined,
    },
    failureReason: p.failureReason,
    summary: receiptSummary(p),
    approvalId: approvalId ?? undefined,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}
export type PurchaseDto = ReturnType<typeof purchaseDto>;

/** Never includes the token hash. */
export function approvalDto(a: ApprovalRow, p?: PurchaseRow) {
  return {
    id: a.id,
    purchaseId: a.purchaseId,
    amount: usd(a.amountCents),
    mandateVersion: a.mandateVersion,
    softRulesFailed: a.softRulesFailed,
    prompt: a.prompt,
    status: a.status,
    expiresAt: a.expiresAt,
    decidedBy: a.decidedBy ?? undefined,
    decidedAt: a.decidedAt ?? undefined,
    createdAt: a.createdAt,
    ...(p ? { mandateId: p.mandateId, product: { id: p.productId, name: p.productName, category: p.productCategory } } : {}),
  };
}
export type ApprovalDto = ReturnType<typeof approvalDto>;

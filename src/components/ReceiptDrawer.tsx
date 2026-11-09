"use client";
import { useEffect, useState } from "react";
import { api, clock, money } from "./api";
import type { Receipt } from "./types";
import { Button, StatusChip } from "./ui";

const EVENT_LABEL: Record<string, string> = {
  "purchase.proposed": "Agent proposed",
  "purchase.blocked": "Blocked by the policy engine",
  "purchase.reserved": "Budget reserved",
  "purchase.authorized": "PayPal authorized",
  "purchase.held": "Held for your approval",
  "purchase.captured": "PayPal captured",
  "purchase.voided": "PayPal authorization voided",
  "purchase.failed": "PayPal failed",
  "purchase.refunded": "PayPal refunded",
  "approval.created": "Approval requested",
  "approval.decided": "You decided",
  "approval.expired": "Approval expired",
  "run.waiting": "Agent waiting for you",
};

export function ReceiptDrawer({ purchaseId, version, onClose }: { purchaseId: string | null; version: number; onClose: () => void }) {
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!purchaseId) return;
    let live = true;
    api<{ receipt: Receipt }>(`/api/purchases/${purchaseId}/receipt`)
      .then((r) => live && (setReceipt(r.receipt), setErr(null)))
      .catch((e) => live && setErr(e.message));
    return () => {
      live = false;
    };
  }, [purchaseId, version]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!purchaseId) return null;
  const p = receipt?.purchase;

  const refund = async () => {
    setBusy(true);
    try {
      await api(`/api/purchases/${purchaseId}/refund`, { body: { reason: "Returned from the dashboard" } });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const passed = receipt ? receipt.ruleResults.filter((r) => r.passed).length : 0;
  const summaryTone =
    p?.status === "BLOCKED" || p?.status === "FAILED"
      ? "border-[#f4c7c2] bg-blocked-bg text-[#7a1810]"
      : p?.status === "CAPTURED"
        ? "border-[#bfe3d3] bg-paid-bg text-[#06513a]"
        : p?.status === "HELD"
          ? "border-[#efd5a8] bg-held-bg text-[#6b3c00]"
          : "border-line bg-sunken text-ink-2";

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-[#0c1b33]/25 backdrop-blur-[2px]" onClick={onClose}>
      <aside
        className="anim-slide scroll-quiet h-full w-full max-w-[600px] overflow-y-auto border-l border-line bg-surface shadow-[-24px_0_48px_-24px_rgba(12,27,51,0.35)]"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Decision receipt"
      >
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-line-soft bg-surface/95 px-6 py-4 backdrop-blur">
          <div className="min-w-0">
            <div className="font-display text-[17px] font-semibold tracking-[-0.01em] text-ink">Decision receipt</div>
            <div className="truncate font-mono text-[12px] text-faint">{purchaseId}</div>
          </div>
          <Button variant="ghost" onClick={onClose} aria-label="Close receipt" className="h-9 w-9 px-0">
            <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
              <path d="m4 4 8 8M12 4l-8 8" />
            </svg>
          </Button>
        </div>

        {err && <div className="mx-6 mt-4 rounded-lg bg-blocked-bg px-3 py-2 text-[14px] text-blocked">{err}</div>}
        {!p ? (
          <div className="space-y-3 p-6" aria-busy="true">
            <div className="h-6 w-2/3 animate-pulse rounded bg-neutral-bg" />
            <div className="h-4 w-1/3 animate-pulse rounded bg-neutral-bg" />
            <div className="h-20 animate-pulse rounded-xl bg-neutral-bg" />
          </div>
        ) : (
          <div className="space-y-7 px-6 py-6">
            <section>
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <h3 className="font-display text-[22px] font-semibold leading-tight tracking-[-0.02em] text-ink">
                    {p.quantity} × {p.product.name}
                  </h3>
                  <div className="mt-1 text-[14px] text-muted">
                    <span className="num">{money(p.product.price.amountCents)}</span> each, <span className="capitalize">{p.product.category.replace(/_/g, " ")}</span>
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <div className="num font-display text-[26px] font-semibold leading-tight tracking-[-0.02em] text-ink">{money(p.total.amountCents)}</div>
                  <StatusChip status={p.status} className="mt-1" />
                </div>
              </div>
              <p className={`mt-5 rounded-xl border px-4 py-3 text-[14.5px] leading-relaxed ${summaryTone}`}>{receipt.summary}</p>
              {p.reason && (
                <blockquote className="mt-4 border-l-2 border-line pl-3 text-[14px] leading-relaxed text-ink-2">
                  <div className="text-[12.5px] font-semibold text-muted">The agent&apos;s reason</div>
                  “{p.reason}”
                </blockquote>
              )}
              <div className="mt-3 text-[13px] text-muted">
                Requested by <span className="font-mono text-[12.5px] text-ink-2">{p.requestedBy}</span> under mandate version {p.mandateVersion}
              </div>
            </section>

            <section>
              <SubHead hint="Checked in code by the policy engine. No AI model decides whether money moves.">
                Rules checked: {passed} of {receipt.ruleResults.length} passed
              </SubHead>
              <ul className="divide-y divide-line-soft overflow-hidden rounded-xl border border-line">
                {receipt.ruleResults.map((r) => (
                  <li key={r.rule} className={`flex items-start gap-3 px-3.5 py-2.5 ${r.passed ? "" : r.kind === "hard" ? "bg-[#fffafa]" : "bg-[#fffcf6]"}`}>
                    <span
                      className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${
                        r.passed ? "bg-paid-bg text-paid" : r.kind === "hard" ? "bg-blocked text-white" : "bg-held text-white"
                      }`}
                      aria-label={r.passed ? "Passed" : "Failed"}
                    >
                      <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        {r.passed ? <path d="m2.5 6.2 2.3 2.3 4.7-5" /> : r.kind === "hard" ? <path d="m3.5 3.5 5 5m0-5-5 5" /> : <path d="M6 2.8v3.8M6 9h0" />}
                      </svg>
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-[12.5px] font-medium text-ink">{r.rule}</span>
                        <span className={`text-[11.5px] font-medium ${r.passed ? "text-faint" : r.kind === "hard" ? "text-blocked" : "text-held"}`}>
                          {r.kind === "hard" ? "Hard rule" : "Soft rule"}
                        </span>
                      </div>
                      <div className="mt-0.5 text-[13.5px] leading-snug text-ink-2">{r.detail}</div>
                    </div>
                  </li>
                ))}
              </ul>
            </section>

            <section>
              <SubHead>PayPal</SubHead>
              {!p.paypal.called ? (
                <div className="rounded-xl border border-[#f4c7c2] bg-blocked-bg px-4 py-3 text-[14px] font-medium text-blocked">
                  PayPal was never called. No money was touched.
                </div>
              ) : (
                <dl className="grid grid-cols-[130px_1fr] gap-y-1.5 rounded-xl border border-line px-4 py-3 text-[14px]">
                  {(
                    [
                      ["Order", p.paypal.orderId],
                      ["Authorization", p.paypal.authorizationId],
                      ["Capture", p.paypal.captureId],
                      ["Refund", p.paypal.refundId],
                      ["Debug id", p.paypal.debugId],
                    ] as const
                  )
                    .filter(([, v]) => v)
                    .map(([k, v]) => (
                      <div key={k} className="contents">
                        <dt className="text-muted">{k}</dt>
                        <dd className="break-all font-mono text-[12.5px] leading-5 text-ink">{v}</dd>
                      </div>
                    ))}
                </dl>
              )}
              {p.status === "CAPTURED" && (
                <Button className="mt-3" onClick={refund} disabled={busy}>
                  {busy ? "Refunding…" : "Refund this purchase"}
                </Button>
              )}
            </section>

            <section>
              <SubHead>Mandate version {receipt.mandateSnapshot.version}, as checked</SubHead>
              <RulesSummary rules={receipt.mandateSnapshot.rules} />
            </section>

            <section>
              <SubHead>Timeline</SubHead>
              <ol className="relative ml-1.5 border-l border-line">
                {receipt.timeline.map((e) => (
                  <li key={e.id} className="relative mb-4 pl-5 last:mb-0">
                    <span className="absolute -left-[5px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-surface bg-ink-2" aria-hidden />
                    <div className="text-[14px] font-medium text-ink">{EVENT_LABEL[e.type] ?? e.type}</div>
                    <div className="text-[12.5px] text-muted">
                      <span className="num">{clock(e.at)}</span> · <span className="font-mono text-[12px]">{e.actor}</span>
                      {typeof e.data?.reason === "string" && e.type !== "purchase.proposed" ? ` · ${e.data.reason}` : ""}
                    </div>
                  </li>
                ))}
              </ol>
            </section>
          </div>
        )}
      </aside>
    </div>
  );
}

function SubHead({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <div className="mb-2.5">
      <h4 className="font-display text-[15px] font-semibold tracking-[-0.01em] text-ink">{children}</h4>
      {hint && <p className="mt-0.5 text-[13px] text-muted">{hint}</p>}
    </div>
  );
}

export function RulesSummary({ rules }: { rules: Receipt["mandateSnapshot"]["rules"] }) {
  const rows: [string, string][] = [
    ["Budget (soft)", money(rules.budget.amountCents)],
    ["Hard limit", money(rules.hardLimit.amountCents)],
    ...(rules.perItemMax ? ([["Per item max", money(rules.perItemMax.amountCents)]] as [string, string][]) : []),
    ["Orders", `${rules.maxOrders} ${rules.period === "once" ? "total" : `per ${rules.period === "weekly" ? "week" : "month"}`}`],
    ["Quantity", `≤ ${rules.maxQuantity} per order`],
    ["Allowed", rules.allowedCategories?.map((c) => c.replace(/_/g, " ")).join(", ") ?? "Anything not blocked"],
    ["Never", rules.blockedCategories.map((c) => c.replace(/_/g, " ")).join(", ")],
    ...(rules.expiresAt ? ([["Expires", new Date(rules.expiresAt).toLocaleString()]] as [string, string][]) : []),
  ];
  return (
    <dl className="grid grid-cols-[130px_1fr] gap-y-1.5 rounded-xl border border-line px-4 py-3 text-[14px]">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className="num text-ink">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

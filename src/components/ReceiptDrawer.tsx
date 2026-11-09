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

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-zinc-900/20 backdrop-blur-[1px]" onClick={onClose}>
      <aside
        className="h-full w-full max-w-xl overflow-y-auto border-l border-zinc-200 bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        aria-label="Decision receipt"
      >
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-zinc-100 bg-white/95 px-6 py-4 backdrop-blur">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Decision receipt</div>
            <div className="font-mono text-xs text-zinc-400">{purchaseId}</div>
          </div>
          <Button variant="ghost" onClick={onClose} aria-label="Close">
            ✕
          </Button>
        </div>

        {err && <div className="mx-6 mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div>}
        {!p ? (
          <div className="p-6 text-sm text-zinc-500">Loading…</div>
        ) : (
          <div className="space-y-6 px-6 py-5">
            <section>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-lg font-semibold text-zinc-900">
                    {p.quantity} × {p.product.name}
                  </div>
                  <div className="mt-0.5 text-sm text-zinc-500">
                    {money(p.product.price.amountCents)} each · <span className="font-mono">{p.product.category}</span>
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-xl font-semibold tabular-nums">{money(p.total.amountCents)}</div>
                  <StatusChip status={p.status} className="mt-1" />
                </div>
              </div>
              <p
                className={`mt-4 rounded-lg px-3 py-2.5 text-sm leading-relaxed ${
                  p.status === "BLOCKED" ? "bg-red-50 text-red-900" : p.status === "CAPTURED" ? "bg-emerald-50 text-emerald-900" : "bg-zinc-50 text-zinc-800"
                }`}
              >
                {receipt.summary}
              </p>
              {p.reason && (
                <div className="mt-3 text-sm text-zinc-600">
                  <span className="font-medium text-zinc-800">Agent&apos;s reason:</span> “{p.reason}”
                </div>
              )}
              <div className="mt-1 text-xs text-zinc-500">
                Requested by <span className="font-mono">{p.requestedBy}</span> under mandate v{p.mandateVersion}
              </div>
            </section>

            <section>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">Rules checked (all {receipt.ruleResults.length}, in code, no LLM)</h3>
              <ul className="divide-y divide-zinc-100 rounded-lg border border-zinc-200">
                {receipt.ruleResults.map((r) => (
                  <li key={r.rule} className="flex items-start gap-3 px-3 py-2 text-sm">
                    <span
                      className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${
                        r.passed ? "bg-emerald-100 text-emerald-700" : r.kind === "hard" ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-800"
                      }`}
                    >
                      {r.passed ? "✓" : r.kind === "hard" ? "✕" : "!"}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[12.5px] text-zinc-900">{r.rule}</span>
                        <span className="text-[10.5px] uppercase tracking-wide text-zinc-400">{r.kind}</span>
                      </div>
                      <div className="text-zinc-600">{r.detail}</div>
                    </div>
                  </li>
                ))}
              </ul>
            </section>

            <section>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">PayPal</h3>
              {!p.paypal.called ? (
                <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-800">PayPal was never called.</div>
              ) : (
                <dl className="grid grid-cols-[120px_1fr] gap-y-1 rounded-lg border border-zinc-200 px-3 py-2 text-sm">
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
                        <dt className="text-zinc-500">{k}</dt>
                        <dd className="font-mono text-[12.5px] text-zinc-800">{v}</dd>
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
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">Mandate v{receipt.mandateSnapshot.version} as checked</h3>
              <RulesSummary rules={receipt.mandateSnapshot.rules} />
            </section>

            <section>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">Timeline</h3>
              <ol className="relative ml-2 border-l border-zinc-200">
                {receipt.timeline.map((e) => (
                  <li key={e.id} className="mb-3 ml-4">
                    <span className="absolute -left-[5px] mt-1.5 h-2.5 w-2.5 rounded-full border-2 border-white bg-zinc-400" />
                    <div className="text-sm text-zinc-800">{EVENT_LABEL[e.type] ?? e.type}</div>
                    <div className="text-xs text-zinc-500">
                      {clock(e.at)} · <span className="font-mono">{e.actor}</span>
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

export function RulesSummary({ rules }: { rules: Receipt["mandateSnapshot"]["rules"] }) {
  const rows: [string, string][] = [
    ["Budget (soft)", money(rules.budget.amountCents)],
    ["Hard limit", money(rules.hardLimit.amountCents)],
    ...(rules.perItemMax ? ([["Per item max", money(rules.perItemMax.amountCents)]] as [string, string][]) : []),
    ["Orders", `${rules.maxOrders} ${rules.period === "once" ? "total" : `per ${rules.period === "weekly" ? "week" : "month"}`}`],
    ["Quantity", `≤ ${rules.maxQuantity} per order`],
    ["Allowed", rules.allowedCategories?.join(", ") ?? "any"],
    ["Never", rules.blockedCategories.join(", ")],
    ...(rules.expiresAt ? ([["Expires", new Date(rules.expiresAt).toLocaleString()]] as [string, string][]) : []),
  ];
  return (
    <dl className="grid grid-cols-[120px_1fr] gap-y-1 rounded-lg border border-zinc-200 px-3 py-2 text-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-zinc-500">{k}</dt>
          <dd className="text-zinc-800">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

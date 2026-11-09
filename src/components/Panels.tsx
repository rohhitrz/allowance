"use client";
import { useEffect, useState } from "react";
import { api, clock, money, timeAgo } from "./api";
import type { Approval, Event, Mandate, Run } from "./types";
import { Button, Card, StatusChip } from "./ui";

// ---------- mandate card ----------

export function MandateCard({ m, run, onChanged, onError }: { m: Mandate; run?: Run; onChanged: () => void; onError: (msg: string) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const spent = m.spend.amount.amountCents;
  const limit = m.hardLimitCents;
  const pct = (v: number) => `${Math.min(100, (v / limit) * 100)}%`;
  const over = spent > m.budgetCents;
  const agentBusy = run && (run.status === "RUNNING" || run.status === "WAITING_APPROVAL");

  const act = async (label: string, path: string, body: unknown = {}) => {
    setBusy(label);
    try {
      const r = await api<{ runError?: string }>(path, { body });
      if (r?.runError) onError(r.runError);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(null);
      onChanged();
    }
  };

  return (
    <Card className={`p-4 ${m.status === "FROZEN" ? "border-sky-200 bg-sky-50/40" : m.status === "DRAFT" ? "border-indigo-200" : ""}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-semibold text-zinc-900">{m.title}</div>
          <div className="mt-0.5 text-xs text-zinc-500">
            {m.period === "once" ? "One-off" : m.period === "weekly" ? "Weekly, resets Monday" : "Monthly"} · v{m.version}
            {m.expiresAt && m.period === "once" ? ` · until ${new Date(m.expiresAt).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}` : ""}
          </div>
        </div>
        <StatusChip status={m.status} />
      </div>

      <div className="mt-3">
        <div className="flex items-baseline justify-between text-sm">
          <span className="tabular-nums">
            <span className={`font-semibold ${over ? "text-amber-700" : "text-zinc-900"}`}>{money(spent)}</span>
            <span className="text-zinc-500"> of {money(m.budgetCents)}</span>
          </span>
          <span className="text-xs text-zinc-500 tabular-nums">never over {money(limit)}</span>
        </div>
        <div className="relative mt-1.5 h-2 overflow-hidden rounded-full bg-zinc-100">
          <div className={`absolute inset-y-0 left-0 rounded-full ${over ? "bg-amber-500" : "bg-emerald-500"}`} style={{ width: pct(spent) }} />
          <div className="absolute inset-y-0 w-0.5 bg-zinc-400" style={{ left: pct(m.budgetCents) }} title="Budget" />
        </div>
        <div className="mt-1.5 flex flex-wrap gap-1 text-[11px] text-zinc-600">
          <span className="rounded bg-zinc-100 px-1.5 py-0.5">
            {m.spend.orders}/{m.maxOrders} orders
          </span>
          <span className="rounded bg-zinc-100 px-1.5 py-0.5">qty ≤ {m.maxQuantity}</span>
          {m.allowedCategories && <span className="rounded bg-zinc-100 px-1.5 py-0.5">{m.allowedCategories.join(", ")}</span>}
          <span className="rounded bg-red-50 px-1.5 py-0.5 text-red-700">no {m.blockedCategories.map((c) => c.replace("_", " ")).join(", ")}</span>
        </div>
      </div>

      {run && (
        <div className="mt-3 flex items-center gap-2 rounded-lg bg-zinc-50 px-2.5 py-1.5 text-xs text-zinc-600">
          <span className={`h-1.5 w-1.5 rounded-full ${agentBusy ? "animate-pulse bg-indigo-500" : "bg-zinc-400"}`} />
          Agent {run.status === "WAITING_APPROVAL" ? "is waiting for you" : run.status.toLowerCase()} · {run.steps.length} step{run.steps.length === 1 ? "" : "s"}
          {run.error ? ` · ${run.error.slice(0, 60)}` : ""}
        </div>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        {m.status === "DRAFT" && (
          <>
            <Button variant="primary" disabled={!!busy} onClick={() => act("confirm", `/api/mandates/${m.id}/confirm`, { startAgent: true })}>
              {busy === "confirm" ? "Starting…" : "Confirm & start agent"}
            </Button>
            <Button disabled={!!busy} onClick={() => act("confirm", `/api/mandates/${m.id}/confirm`, { startAgent: false })}>
              Confirm only
            </Button>
            <Button variant="ghost" disabled={!!busy} onClick={() => act("cancel", `/api/mandates/${m.id}/cancel`)}>
              Discard
            </Button>
          </>
        )}
        {m.status === "ACTIVE" && (
          <>
            <Button disabled={!!busy || !!agentBusy} onClick={() => act("run", `/api/mandates/${m.id}/runs`)}>
              {agentBusy ? "Agent shopping…" : busy === "run" ? "Starting…" : "Run agent"}
            </Button>
            {agentBusy && run && (
              <Button variant="ghost" onClick={() => act("stop", `/api/runs/${run.id}/stop`)}>
                Stop agent
              </Button>
            )}
            <Button variant="ghost" disabled={!!busy} onClick={() => act("cancel", `/api/mandates/${m.id}/cancel`)}>
              Cancel mandate
            </Button>
          </>
        )}
        {m.status === "FROZEN" && (
          <Button disabled={!!busy} onClick={() => act("unfreeze", `/api/mandates/${m.id}/unfreeze`)}>
            {busy === "unfreeze" ? "…" : "Unfreeze (v" + (m.version + 1) + ")"}
          </Button>
        )}
      </div>
    </Card>
  );
}

// ---------- approval card ----------

export function ApprovalCard({ a, onDecided, onError }: { a: Approval; onDecided: () => void; onError: (m: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [left, setLeft] = useState(() => new Date(a.expiresAt).getTime() - Date.now());
  useEffect(() => {
    const t = setInterval(() => setLeft(new Date(a.expiresAt).getTime() - Date.now()), 1000);
    return () => clearInterval(t);
  }, [a.expiresAt]);

  const decide = async (decision: "approve" | "reject") => {
    setBusy(true);
    try {
      await api(`/api/approvals/${a.id}/decision`, { body: { decision } });
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
      onDecided();
    }
  };
  const mm = Math.max(0, Math.floor(left / 60000));
  const ss = Math.max(0, Math.floor((left % 60000) / 1000));

  return (
    <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 shadow-sm ring-4 ring-amber-100">
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold uppercase tracking-wider text-amber-800">Waiting for you</div>
        <div className="font-mono text-xs text-amber-800 tabular-nums">
          {mm}:{String(ss).padStart(2, "0")}
        </div>
      </div>
      <p className="mt-1.5 text-[15px] leading-snug text-zinc-900">{a.prompt}</p>
      <div className="mt-1 text-xs text-zinc-600">
        PayPal has authorized {money(a.amount.amountCents)} and is holding it. Nothing is captured until you approve.
      </div>
      <div className="mt-3 flex gap-2">
        <Button variant="approve" disabled={busy} onClick={() => decide("approve")}>
          Approve
        </Button>
        <Button variant="secondary" disabled={busy} onClick={() => decide("reject")}>
          Reject
        </Button>
      </div>
    </div>
  );
}

// ---------- live feed ----------

const FEED_TEXT: Record<string, (e: Event) => string> = {
  "mandate.drafted": (e) => `Drafted “${e.data.title ?? "mandate"}”`,
  "mandate.confirmed": () => "Mandate confirmed",
  "mandate.frozen": () => "Mandate frozen",
  "mandate.unfrozen": (e) => `Unfrozen (v${e.data.version})`,
  "mandate.cancelled": () => "Mandate cancelled",
  "mandate.expired": () => "Mandate expired",
  "run.started": () => "Agent started shopping",
  "run.step": (e) => stepText(e),
  "run.waiting": () => "Agent is waiting for your approval",
  "run.finished": (e) => `Agent finished: ${String(e.data.status).toLowerCase()}`,
  "purchase.proposed": (e) => `Proposed ${e.data.quantity} × ${e.data.productName} (${money(Number(e.data.totalCents))})`,
  "purchase.blocked": (e) =>
    `Blocked: ${((e.data.failed as { rule: string }[]) ?? []).map((r) => r.rule).join(", ")}. PayPal never called`,
  "purchase.reserved": () => "Budget reserved",
  "purchase.authorized": () => "PayPal authorized",
  "purchase.held": () => "Held for approval",
  "purchase.captured": () => "PayPal captured",
  "purchase.voided": (e) => `Voided: ${e.data.reason ?? ""}`,
  "purchase.failed": (e) => `PayPal failed: ${e.data.reason ?? ""}`,
  "purchase.refunded": () => "Refunded",
  "approval.created": () => "Approval requested",
  "approval.decided": (e) => `You said ${e.data.decision}`,
  "approval.expired": () => "Approval expired",
  "vault.linked": () => "PayPal linked",
};

function stepText(e: Event) {
  const tool = String(e.data.tool);
  const input = (e.data.input ?? {}) as Record<string, unknown>;
  if (tool === "search_catalog") return `Agent searched “${input.query}”`;
  if (tool === "get_product") return `Agent read ${input.productId}`;
  if (tool === "request_purchase") return `Agent: ${String(e.data.output).split(":")[0].toLowerCase()} → ${String(input.reason ?? "")}`;
  return `Agent used ${tool}`;
}

const DOT: Record<string, string> = {
  "purchase.blocked": "bg-red-500",
  "purchase.failed": "bg-red-500",
  "purchase.captured": "bg-emerald-500",
  "purchase.held": "bg-amber-500",
  "approval.created": "bg-amber-500",
  "mandate.frozen": "bg-sky-500",
  "purchase.voided": "bg-zinc-400",
};

export function Feed({ events, onOpen }: { events: Event[]; onOpen: (purchaseId: string) => void }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 15_000);
    return () => clearInterval(t);
  }, []);
  if (!events.length) return <div className="px-1 text-sm text-zinc-500">Nothing yet.</div>;
  return (
    <ol className="space-y-0.5">
      {[...events].reverse().map((e) => {
        const text = (FEED_TEXT[e.type] ?? ((x: Event) => x.type))(e);
        const click = e.purchaseId ? () => onOpen(e.purchaseId!) : undefined;
        return (
          <li
            key={e.id}
            onClick={click}
            className={`flex gap-2.5 rounded-lg px-2 py-1.5 text-[13px] ${click ? "cursor-pointer hover:bg-zinc-50" : ""}`}
          >
            <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${DOT[e.type] ?? "bg-zinc-300"}`} />
            <div className="min-w-0 flex-1">
              <div className="text-zinc-800">{text}</div>
              <div className="text-[11px] text-zinc-400" title={clock(e.at)}>
                {timeAgo(e.at)} · {e.actor}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

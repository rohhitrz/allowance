"use client";
import { useEffect, useState } from "react";
import { api, clock, money, timeAgo } from "./api";
import type { Approval, Event, Mandate, Run } from "./types";
import { Button, Card, StatusChip, Tag } from "./ui";

// ---------- mandate card ----------

export function MandateCard({
  m,
  run,
  onChanged,
  onError,
  onReport,
}: {
  m: Mandate;
  run?: Run;
  onChanged: () => void;
  onError: (msg: string) => void;
  /** Open the red-team report for a run. */
  onReport: (runId: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const spent = m.spend.amount.amountCents;
  const limit = m.hardLimitCents;
  const pct = (v: number) => `${Math.min(100, (v / limit) * 100)}%`;
  const over = spent > m.budgetCents;
  const agentBusy = run && (run.status === "RUNNING" || run.status === "WAITING_APPROVAL");
  const redTeam = run?.brief === "RED TEAM";

  const attack = async () => {
    setBusy("attack");
    try {
      const r = await api<{ run: Run }>(`/api/mandates/${m.id}/red-team`, { body: {} });
      onReport(r.run.id);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(null);
      onChanged();
    }
  };

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

  const period = m.period === "once" ? "One-off" : m.period === "weekly" ? "Weekly, resets Monday" : "Monthly";
  const until =
    m.expiresAt && m.period === "once"
      ? `until ${new Date(m.expiresAt).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}`
      : null;
  const frame =
    m.status === "FROZEN" ? "border-[#bcd2ec] bg-[#f5f9fd]" : m.status === "DRAFT" ? "border-[#c7d3f5] border-dashed" : "border-line";

  return (
    <Card className={`overflow-hidden ${frame}`}>
      <div className="p-4 pb-3.5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="font-display text-[16.5px] font-semibold leading-snug tracking-[-0.01em] text-ink">{m.title}</h3>
            <div className="mt-0.5 text-[13px] text-muted">
              {period}
              {until ? `, ${until}` : ""}
              <span className="text-faint"> · version {m.version}</span>
            </div>
          </div>
          <StatusChip status={m.status} className="shrink-0" />
        </div>

        <div className="mt-4">
          <div className="flex items-end justify-between gap-3">
            <div className="num leading-none">
              <span className={`font-display text-[28px] font-semibold tracking-[-0.03em] ${over ? "text-held" : "text-ink"}`}>{money(spent)}</span>
              <span className="ml-1.5 text-[14px] text-muted">of {money(m.budgetCents)} budget</span>
            </div>
          </div>
          {/* Spend meter: the track ends at the hard limit; the tick marks the soft budget. */}
          <div className="relative mt-3 h-2.5 rounded-full bg-neutral-bg" role="meter" aria-valuemin={0} aria-valuemax={limit} aria-valuenow={spent} aria-label="Spent so far">
            <div
              className={`absolute inset-y-0 left-0 rounded-full transition-[width] duration-500 ${over ? "bg-held" : "bg-paid"}`}
              style={{ width: pct(spent) }}
            />
            <div className="absolute -top-1 -bottom-1 w-[2px] rounded-full bg-ink" style={{ left: `calc(${pct(m.budgetCents)} - 1px)` }} title={`Budget ${money(m.budgetCents)}`} />
          </div>
          <div className="num mt-1.5 flex justify-between text-[12px] text-muted">
            <span>$0</span>
            <span className="font-medium text-ink-2">Hard limit {money(limit)}</span>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap gap-1.5">
          <Tag>
            {m.spend.orders} of {m.maxOrders} orders
          </Tag>
          <Tag>Up to {m.maxQuantity} per order</Tag>
          {m.allowedCategories && <Tag>{m.allowedCategories.map(pretty).join(", ")}</Tag>}
          <Tag tone="blocked">Never {m.blockedCategories.map(pretty).join(", ")}</Tag>
        </div>
      </div>

      {run && (
        <div className="flex items-center gap-2 border-t border-line-soft bg-sunken px-4 py-2 text-[13px] text-ink-2">
          <span className="relative flex h-2 w-2 shrink-0">
            {agentBusy && <span className={`absolute inset-0 animate-ping rounded-full ${redTeam ? "bg-blocked/50" : "bg-accent/50"}`} />}
            <span className={`relative h-2 w-2 rounded-full ${agentBusy ? (redTeam ? "bg-blocked" : "bg-accent") : "bg-faint"}`} />
          </span>
          <span className="min-w-0 flex-1 truncate">
            {redTeam ? (agentBusy ? "Red team is attacking" : "Red team finished") : `Agent ${run.status === "WAITING_APPROVAL" ? "is waiting for you" : run.status.toLowerCase()}`}, {run.steps.length} step
            {run.steps.length === 1 ? "" : "s"}
            {run.error ? `: ${run.error.slice(0, 60)}` : ""}
          </span>
          {redTeam && (
            <button onClick={() => onReport(run.id)} className="shrink-0 text-[13px] font-semibold text-accent hover:underline">
              View report
            </button>
          )}
        </div>
      )}

      {m.status !== "EXPIRED" && (
        <div className="flex flex-wrap gap-2 border-t border-line-soft px-4 py-3">
          {m.status === "DRAFT" && (
            <>
              <Button variant="primary" disabled={!!busy} onClick={() => act("confirm", `/api/mandates/${m.id}/confirm`, { startAgent: true })}>
                {busy === "confirm" ? "Starting…" : "Confirm and start agent"}
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
              <Button variant="primary" disabled={!!busy || !!agentBusy} onClick={() => act("run", `/api/mandates/${m.id}/runs`)}>
                {agentBusy && !redTeam ? "Agent shopping…" : busy === "run" ? "Starting…" : "Run agent"}
              </Button>
              <Button disabled={!!busy || !!agentBusy} onClick={attack} title="Let Claude try to break this mandate's rules. Real checks, real PayPal sandbox.">
                {agentBusy && redTeam ? "Attacking…" : busy === "attack" ? "Starting…" : "Red-team it"}
              </Button>
              {agentBusy && run && (
                <Button onClick={() => act("stop", `/api/runs/${run.id}/stop`)}>Stop agent</Button>
              )}
              <Button variant="ghost" disabled={!!busy} onClick={() => act("cancel", `/api/mandates/${m.id}/cancel`)}>
                Cancel mandate
              </Button>
            </>
          )}
          {m.status === "FROZEN" && (
            <Button variant="primary" disabled={!!busy} onClick={() => act("unfreeze", `/api/mandates/${m.id}/unfreeze`)}>
              {busy === "unfreeze" ? "Unfreezing…" : `Unfreeze as version ${m.version + 1}`}
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}

const pretty = (c: string) => c.replace(/_/g, " ");

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

  const total = new Date(a.expiresAt).getTime() - new Date(a.createdAt).getTime();
  const frac = total > 0 ? Math.max(0, Math.min(1, left / total)) : 0;

  return (
    <div className="anim-rise overflow-hidden rounded-2xl border border-[#efc98a] bg-surface shadow-[0_10px_30px_-14px_rgba(163,90,0,0.45)]">
      <div className="h-1 bg-held-bg">
        <div className="h-full bg-held transition-[width] duration-1000 ease-linear" style={{ width: `${frac * 100}%` }} />
      </div>
      <div className="p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-[13px] font-semibold text-held">
            <span className="relative flex h-2 w-2">
              <span className="absolute inset-0 animate-ping rounded-full bg-held/50" />
              <span className="relative h-2 w-2 rounded-full bg-held" />
            </span>
            Waiting for your approval
          </div>
          <div className="num rounded-md bg-held-bg px-2 py-0.5 text-[13px] font-semibold text-held" aria-label="Time left">
            {mm}:{String(ss).padStart(2, "0")}
          </div>
        </div>
        <p className="mt-2.5 font-display text-[17px] font-medium leading-snug tracking-[-0.01em] text-ink">{a.prompt}</p>
        <p className="mt-1.5 text-[13.5px] leading-relaxed text-muted">
          PayPal is holding <span className="num font-semibold text-ink-2">{money(a.amount.amountCents)}</span>. Nothing is charged until you approve.
        </p>
        <div className="mt-4 flex gap-2">
          <Button variant="approve" disabled={busy} onClick={() => decide("approve")} className="flex-1 sm:flex-none sm:px-5">
            Approve
          </Button>
          <Button variant="secondary" disabled={busy} onClick={() => decide("reject")} className="flex-1 sm:flex-none sm:px-5">
            Reject
          </Button>
        </div>
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
  "run.started": (e) => (e.data.redTeam ? "Red team started attacking this mandate" : "Agent started shopping"),
  "run.step": (e) => stepText(e),
  "run.waiting": () => "Agent is waiting for your approval",
  "run.finished": (e) => (e.data.summary ? String(e.data.summary) : `Agent finished: ${String(e.data.status).toLowerCase()}`),
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
  if (e.data.redTeam) {
    const outcome = String(e.data.output).split(/[:(]/)[0].trim().toLowerCase();
    if (tool === "request_purchase") return `Red team tried “${input.tactic}”: ${outcome}`;
    if (tool === "admin_action") return `Red team tried to ${String(input.action).replace(/_/g, " ")}: ${outcome}`;
    if (tool === "search_catalog") return `Red team searched “${input.query}”`;
    return `Red team read ${input.productId ?? tool}`;
  }
  if (tool === "search_catalog") return `Agent searched “${input.query}”`;
  if (tool === "get_product") return `Agent read ${input.productId}`;
  if (tool === "request_purchase") return `Agent: ${String(e.data.output).split(":")[0].toLowerCase()} → ${String(input.reason ?? "")}`;
  return `Agent used ${tool}`;
}

const DOT: Record<string, string> = {
  "purchase.blocked": "bg-blocked",
  "purchase.failed": "bg-blocked",
  "purchase.captured": "bg-paid",
  "purchase.refunded": "bg-frozen",
  "purchase.held": "bg-held",
  "approval.created": "bg-held",
  "mandate.frozen": "bg-frozen",
  "purchase.voided": "bg-faint",
  "run.started": "bg-accent",
};

const actorLabel = (a: string) =>
  a === "agent:allowance" ? "Agent" : a.startsWith("mcp:") ? `MCP ${a.slice(4)}` : a.startsWith("user:") ? "You" : a === "system" ? "System" : a;

export function Feed({ events, onOpen }: { events: Event[]; onOpen: (purchaseId: string) => void }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 15_000);
    return () => clearInterval(t);
  }, []);
  if (!events.length)
    return <div className="px-3 py-6 text-center text-[14px] text-muted">Nothing yet. Activity shows up here as the agent shops.</div>;
  return (
    <ol>
      {[...events].reverse().map((e) => {
        const text = (FEED_TEXT[e.type] ?? ((x: Event) => x.type))(e);
        const purchaseId = e.purchaseId;
        const body = (
          <>
            <span className={`mt-[7px] h-2 w-2 shrink-0 rounded-full ring-[3px] ring-surface ${DOT[e.type] ?? "bg-line"}`} aria-hidden />
            <div className="min-w-0 flex-1">
              <div className="text-[14px] leading-snug text-ink">{text}</div>
              <div className="mt-0.5 text-[12px] text-faint" title={clock(e.at)}>
                {timeAgo(e.at)} · {actorLabel(e.actor)}
              </div>
            </div>
          </>
        );
        return (
          <li key={e.id}>
            {purchaseId ? (
              <button
                type="button"
                onClick={() => onOpen(purchaseId)}
                className="flex w-full gap-3 rounded-lg px-2.5 py-2 text-left hover:bg-sunken"
                title="Open the receipt"
              >
                {body}
              </button>
            ) : (
              <div className="flex gap-3 px-2.5 py-2">{body}</div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

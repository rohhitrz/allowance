"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, money } from "./api";
import { CommandBar, type CommandBarHandle } from "./CommandBar";
import { Ledger, type LedgerHandle } from "./Ledger";
import { ApprovalCard, Feed, MandateCard } from "./Panels";
import { ReceiptDrawer } from "./ReceiptDrawer";
import type { Approval, Event, Mandate, Purchase, Run } from "./types";
import { BrandMark, Button, SectionTitle } from "./ui";

const DEMO_STEPS = [
  ["mandate", "1. Gift mandate"],
  ["headphones", "2. $170 headphones (hold)"],
  ["candle", "3. $89.99 candle set"],
  ["attack", "4. Injection: 5 gift cards"],
  ["freeze", "5. Stop everything"],
  ["retry", "6. Agent retries"],
] as const;

export function Dashboard() {
  const [demoMode, setDemoMode] = useState(false);
  const [mandates, setMandates] = useState<Mandate[]>([]);
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [events, setEvents] = useState<Event[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [vault, setVault] = useState<{ linked: boolean; payerEmail?: string } | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [receiptVersion, setReceiptVersion] = useState(0);
  const [toast, setToast] = useState<{ kind: "error" | "info"; text: string } | null>(null);
  const [connected, setConnected] = useState(false);
  const [quickFilter, setQuickFilter] = useState("");
  const [freezing, setFreezing] = useState(false);
  const ledger = useRef<LedgerHandle>(null);
  const voice = useRef<CommandBarHandle>(null);
  const openRef = useRef<string | null>(null);
  useEffect(() => {
    openRef.current = openId;
  }, [openId]);

  const flash = useCallback((text: string, kind: "error" | "info" = "error") => {
    setToast({ kind, text });
    setTimeout(() => setToast((t) => (t?.text === text ? null : t)), 6000);
  }, []);

  const loadMandates = useCallback(async () => {
    const [m, r] = await Promise.all([api<{ mandates: Mandate[] }>("/api/mandates"), api<{ runs: Run[] }>("/api/runs")]);
    setMandates(m.mandates.filter((x) => x.status !== "CANCELLED"));
    setRuns(r.runs);
  }, []);
  const loadApprovals = useCallback(async () => {
    setApprovals((await api<{ approvals: Approval[] }>("/api/approvals?status=PENDING")).approvals);
  }, []);
  const loadAll = useCallback(async () => {
    const [p, e, v] = await Promise.all([
      api<{ purchases: Purchase[] }>("/api/purchases"),
      api<{ events: Event[] }>("/api/events?limit=60"),
      api<{ linked: boolean; payerEmail?: string }>("/api/paypal/vault"),
      loadMandates(),
      loadApprovals(),
    ]);
    setPurchases(p.purchases);
    ledger.current?.setRows(p.purchases);
    setEvents(e.events);
    setVault(v);
  }, [loadMandates, loadApprovals]);

  useEffect(() => {
    // Initial load from the API (an external system); state is set after the fetches resolve.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadAll().catch((e) => flash(e.message));
    api<{ demoMode?: boolean }>("/api/health").then((h) => setDemoMode(Boolean(h.demoMode))).catch(() => {});
    const q = new URLSearchParams(window.location.search);
    if (q.get("vault") === "linked") flash("PayPal linked. Purchases now authorize without a popup.", "info");
    if (q.get("vault") === "error") flash(`PayPal linking failed: ${q.get("message") ?? ""}`);
    // Back from the PayPal popup checkout (no saved PayPal account): show what happened.
    const paypal = q.get("paypal");
    if (paypal === "error") flash(`PayPal checkout failed: ${q.get("message") ?? ""}`);
    else if (paypal === "cancelled") flash("PayPal checkout cancelled. The reservation was released.", "info");
    else if (paypal === "captured") flash("Approved in PayPal. The purchase is paid.", "info");
    else if (paypal === "held") flash("Approved in PayPal. It's over a soft rule, so it's waiting for your approval here.", "info");
    else if (paypal) flash(`PayPal checkout did not complete: the purchase is ${paypal}.`);
    if (q.get("purchase")) setOpenId(q.get("purchase"));
    if (paypal || q.get("vault")) window.history.replaceState(null, "", "/");
  }, [loadAll, flash]);

  // Live updates. Debounce refetches of the small lists; upsert ledger rows individually.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const pendingPurchases = new Set<string>();
    let needMandates = false;
    let needApprovals = false;
    const flush = async () => {
      timer = null;
      const ids = [...pendingPurchases];
      pendingPurchases.clear();
      const jobs: Promise<unknown>[] = ids.map((id) =>
        api<{ purchase: Purchase }>(`/api/purchases/${id}`).then(({ purchase }) => {
          ledger.current?.upsert(purchase);
          setPurchases((rows) => {
            const i = rows.findIndex((r) => r.id === purchase.id);
            return i < 0 ? [purchase, ...rows] : rows.map((r) => (r.id === purchase.id ? purchase : r));
          });
          if (openRef.current === purchase.id) setReceiptVersion((v) => v + 1);
        }),
      );
      if (needMandates) jobs.push(loadMandates());
      if (needApprovals) jobs.push(loadApprovals());
      needMandates = needApprovals = false;
      await Promise.allSettled(jobs);
    };
    const schedule = () => (timer ??= setTimeout(flush, 150));

    const es = new EventSource("/api/events/stream");
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = () => {};
    const onAny = (msg: MessageEvent) => {
      const e = JSON.parse(msg.data) as Event;
      setEvents((list) => (list.some((x) => x.id === e.id) ? list : [...list.slice(-99), e]));
      if (e.purchaseId) pendingPurchases.add(e.purchaseId);
      if (e.type.startsWith("mandate.") || e.type.startsWith("run.") || e.type.startsWith("purchase.")) needMandates = true;
      if (e.type.startsWith("approval.") || e.type === "purchase.voided" || e.type === "mandate.frozen") needApprovals = true;
      if (e.type === "approval.created") {
        const prompt = String(e.data.prompt ?? "");
        const id = String(e.data.approvalId ?? "");
        if (prompt && id) voice.current?.announceApproval({ id, prompt } as Approval);
      }
      // Tell the user how a run ended (only live events, not ones replayed after a reconnect).
      if (e.type === "run.finished" && e.data.summary && Date.now() - new Date(e.at).getTime() < 30_000) {
        voice.current?.announce(String(e.data.summary));
      }
      if (e.type === "vault.linked") api<{ linked: boolean }>("/api/paypal/vault").then(setVault);
      schedule();
    };
    const TYPES = [
      "mandate.drafted", "mandate.confirmed", "mandate.frozen", "mandate.unfrozen", "mandate.cancelled", "mandate.expired",
      "run.started", "run.step", "run.waiting", "run.finished",
      "purchase.proposed", "purchase.blocked", "purchase.reserved", "purchase.authorized", "purchase.held",
      "purchase.captured", "purchase.voided", "purchase.failed", "purchase.refunded",
      "approval.created", "approval.decided", "approval.expired", "vault.linked",
    ];
    for (const t of TYPES) es.addEventListener(t, onAny as EventListener);
    return () => {
      es.close();
      if (timer) clearTimeout(timer);
    };
  }, [loadMandates, loadApprovals]);

  const latestRun = useMemo(() => {
    const byMandate: Record<string, Run> = {};
    for (const r of runs) if (!byMandate[r.mandateId]) byMandate[r.mandateId] = r;
    return byMandate;
  }, [runs]);

  const stats = useMemo(() => {
    const c = (s: string) => purchases.filter((p) => p.status === s).length;
    return { total: purchases.length, captured: c("CAPTURED"), blocked: c("BLOCKED"), held: c("HELD") };
  }, [purchases]);

  const freeze = async () => {
    setFreezing(true);
    try {
      const r = await api<{ frozen: number; voided: number }>("/api/freeze-all", { body: {} });
      flash(`Stopped. ${r.frozen} mandate(s) frozen, ${r.voided} hold(s) voided.`, "info");
    } catch (e) {
      flash((e as Error).message);
    } finally {
      setFreezing(false);
      void loadMandates();
      void loadApprovals();
    }
  };

  const linkPayPal = async () => {
    try {
      const { approveUrl } = await api<{ approveUrl: string }>("/api/paypal/vault/setup", { body: {} });
      window.location.href = approveUrl;
    } catch (e) {
      flash((e as Error).message);
    }
  };

  const demo = async (step: string) => {
    try {
      if (step === "reset") {
        await api("/api/demo/reset", { body: {} });
        ledger.current?.setRows([]);
        setPurchases([]);
        setEvents([]);
        await loadAll();
        flash("Demo reset.", "info");
        return;
      }
      await api("/api/demo/script", { body: { step } });
    } catch (e) {
      flash((e as Error).message);
    }
  };

  const anyActive = mandates.some((m) => m.status === "ACTIVE");
  // No saved PayPal account: these passed the rules and wait for the buyer to approve in PayPal.
  const awaitingBuyer = purchases.filter((p) => p.status === "RESERVED" && p.paypal.approveUrl);

  return (
    <div className="min-h-screen bg-canvas">
      <header className="sticky top-0 z-30 border-b border-line bg-surface/90 backdrop-blur-md">
        <div className="mx-auto flex max-w-[1600px] items-center gap-3 px-4 py-3 sm:px-6">
          <div className="flex shrink-0 items-center gap-3">
            <BrandMark />
            <div className="min-w-0">
              <div className="font-display text-[19px] font-semibold leading-tight tracking-[-0.02em] text-ink">Allowance</div>
              <div className="hidden truncate text-[12.5px] leading-tight text-muted sm:block">Your agent can be fooled. Your money can&apos;t.</div>
            </div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <span
              className={`hidden items-center gap-1.5 rounded-full px-2.5 py-1 text-[12.5px] font-medium sm:inline-flex ${connected ? "bg-paid-bg text-paid" : "bg-neutral-bg text-muted"}`}
              title={connected ? "Receiving live updates" : "Reconnecting to live updates"}
            >
              <span className="relative flex h-2 w-2">
                {connected && <span className="absolute inset-0 animate-ping rounded-full bg-paid/50" />}
                <span className={`relative h-2 w-2 rounded-full ${connected ? "bg-paid" : "bg-faint"}`} />
              </span>
              {connected ? "Live" : "Reconnecting"}
            </span>
            {vault &&
              (vault.linked ? (
                <span
                  className="hidden max-w-[280px] items-center gap-2 truncate rounded-full border border-line bg-surface py-1 pl-1.5 pr-3 text-[12.5px] text-ink-2 lg:inline-flex"
                  title={`PayPal linked (sandbox)${vault.payerEmail ? `: ${vault.payerEmail}` : ""}`}
                >
                  <PayPalGlyph />
                  <span className="truncate">{vault.payerEmail ?? "PayPal linked"}</span>
                </span>
              ) : (
                <Button onClick={linkPayPal} className="hidden md:inline-flex">
                  <PayPalGlyph /> Link PayPal
                </Button>
              ))}
            {demoMode && (
              <select
                className="h-9 w-[44px] rounded-lg border border-line bg-surface px-2.5 text-[14px] text-ink-2 hover:border-[#c9d0db] sm:w-auto"
                value=""
                onChange={(e) => e.target.value && demo(e.target.value)}
                aria-label="Demo script"
              >
                <option value="">Demo script</option>
                {DEMO_STEPS.map(([k, label]) => (
                  <option key={k} value={k}>
                    {label}
                  </option>
                ))}
                <option value="reset">Reset demo data</option>
              </select>
            )}
            <Button
              variant="danger"
              onClick={freeze}
              disabled={freezing || !anyActive}
              className="px-3 sm:px-4"
              title="Kill switch: freeze every mandate and void open holds"
            >
              <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="currentColor" aria-hidden>
                <rect x="3" y="3" width="10" height="10" rx="2" />
              </svg>
              {freezing ? "Stopping…" : (
                <>
                  <span className="sm:hidden">Stop</span>
                  <span className="hidden sm:inline">Stop everything</span>
                </>
              )}
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto grid w-full max-w-[1600px] grid-cols-1 gap-6 px-4 py-6 sm:px-6 lg:grid-cols-[360px_minmax(0,1fr)] xl:grid-cols-[360px_minmax(0,1fr)_300px]">
        <section className="min-w-0 space-y-6">
          <div>
            <SectionTitle hint="Type or talk. Set a budget, approve a hold, or stop the agent.">Tell Allowance</SectionTitle>
            <CommandBar ref={voice} onChanged={() => void loadMandates()} />
          </div>
          {(approvals.length > 0 || awaitingBuyer.length > 0) && (
            <div className="space-y-3">
              {approvals.map((a) => (
                <ApprovalCard key={a.id} a={a} onDecided={() => void loadApprovals()} onError={flash} />
              ))}
              {awaitingBuyer.map((p) => (
                <div key={p.id} className="anim-rise rounded-2xl border border-[#c7d3f5] bg-[#f3f6fe] p-4">
                  <div className="flex items-center gap-2 text-[13px] font-semibold text-accent">
                    <PayPalGlyph /> Finish in PayPal
                  </div>
                  <p className="mt-2 text-[15px] leading-snug text-ink">
                    {p.quantity} × {p.product.name}, <span className="num font-semibold">{money(p.total.amountCents)}</span>, passed your rules. No PayPal
                    account is linked, so PayPal needs your approval for this one.
                  </p>
                  <div className="mt-3 flex gap-2">
                    <a
                      href={p.paypal.approveUrl}
                      className="inline-flex h-9 items-center rounded-lg bg-[#003087] px-3.5 text-[14px] font-semibold text-white hover:bg-[#00256b]"
                    >
                      Approve in PayPal
                    </a>
                    <a
                      href={`/paypal/cancel?purchase=${p.id}`}
                      className="inline-flex h-9 items-center rounded-lg bg-surface px-3.5 text-[14px] font-semibold text-ink ring-1 ring-inset ring-line hover:bg-sunken"
                    >
                      Cancel
                    </a>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div>
            <SectionTitle hint="What your agent is allowed to spend.">Mandates</SectionTitle>
            <div className="space-y-3">
              {mandates.length === 0 && (
                <div className="rounded-2xl border border-dashed border-line px-4 py-6 text-center text-[14px] text-muted">
                  No mandates yet. Describe one above, for example “groceries, $80 a week”.
                </div>
              )}
              {mandates.map((m) => (
                <MandateCard key={m.id} m={m} run={latestRun[m.id]} onChanged={() => void loadMandates()} onError={flash} />
              ))}
            </div>
          </div>
        </section>

        <section className="flex min-w-0 flex-col">
          <SectionTitle
            hint="Every purchase attempt, with the rules it was checked against. Click a row for the full receipt."
            right={
              <label className="relative block w-full sm:w-72">
                <span className="sr-only">Filter the ledger</span>
                <svg viewBox="0 0 20 20" className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
                  <circle cx="9" cy="9" r="5.5" />
                  <path d="m13.5 13.5 3 3" strokeLinecap="round" />
                </svg>
                <input
                  value={quickFilter}
                  onChange={(e) => setQuickFilter(e.target.value)}
                  placeholder="Filter by status, category, product"
                  className="h-9 w-full rounded-lg border border-line bg-surface pl-8 pr-3 text-[14px] text-ink outline-none placeholder:text-faint focus:border-accent focus:ring-2 focus:ring-accent/15"
                />
              </label>
            }
          >
            Receipts ledger
          </SectionTitle>
          <div className="mb-3 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
            {(
              [
                ["Attempts", stats.total, "text-ink", "bg-ink", ""],
                ["Paid", stats.captured, "text-paid", "bg-paid", "captured"],
                ["Held for you", stats.held, "text-held", "bg-held", "held"],
                ["Blocked", stats.blocked, "text-blocked", "bg-blocked", "blocked"],
              ] as const
            ).map(([label, n, color, bar, q]) => {
              const on = Boolean(q) && quickFilter === q;
              return (
                <button
                  key={label}
                  onClick={() => setQuickFilter((cur) => (cur === q ? "" : q))}
                  aria-pressed={on}
                  className={`group relative overflow-hidden rounded-xl border bg-surface px-3.5 py-2.5 text-left transition-colors hover:border-[#c2cad6] ${
                    on ? "border-ink ring-1 ring-ink" : "border-line"
                  }`}
                >
                  <span className={`absolute inset-y-0 left-0 w-[3px] ${bar}`} aria-hidden />
                  <div className="text-[13px] font-medium text-muted">{label}</div>
                  <div className={`num font-display text-[26px] font-semibold leading-tight tracking-[-0.02em] ${color}`}>{n}</div>
                </button>
              );
            })}
          </div>
          <div className="h-[calc(100vh-260px)] min-h-[440px]">
            <Ledger ref={ledger} rows={purchases} mandates={mandates} onOpen={(p) => setOpenId(p.id)} quickFilter={quickFilter} />
          </div>
        </section>

        <section className="min-w-0 lg:col-span-2 xl:col-span-1">
          <SectionTitle hint="What the agent and PayPal are doing right now.">Live activity</SectionTitle>
          <div className="scroll-quiet max-h-[calc(100vh-150px)] overflow-y-auto rounded-2xl border border-line bg-surface px-2 py-2">
            <Feed events={events} onOpen={setOpenId} />
          </div>
        </section>
      </main>

      {toast && (
        <div
          className={`anim-rise fixed bottom-6 left-1/2 z-50 flex max-w-[calc(100vw-32px)] -translate-x-1/2 items-start gap-2.5 rounded-xl px-4 py-3 text-[14px] leading-snug text-white shadow-[0_12px_32px_-8px_rgba(12,27,51,0.45)] ${
            toast.kind === "error" ? "bg-blocked" : "bg-ink"
          }`}
          role="status"
        >
          <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${toast.kind === "error" ? "bg-white" : "bg-[#7fd3b0]"}`} aria-hidden />
          {toast.text}
        </div>
      )}
      <ReceiptDrawer purchaseId={openId} version={receiptVersion} onClose={() => setOpenId(null)} />
    </div>
  );
}

function PayPalGlyph() {
  return (
    <svg viewBox="0 0 20 20" className="h-4 w-4 shrink-0" aria-hidden>
      <circle cx="10" cy="10" r="10" fill="#003087" />
      <path d="M7.3 14.6 8.6 5.6h3.2c1.9 0 2.9 1 2.6 2.6-.3 1.9-1.6 2.8-3.4 2.8H9.6l-.5 3.6z" fill="#fff" />
      <path d="M9.6 11h1.4c1.8 0 3.1-.9 3.4-2.8l.1-.5c.6.5.8 1.3.6 2.2-.3 1.8-1.6 2.7-3.4 2.7h-.9l-.3 2H8.9z" fill="#4fa3e0" />
    </svg>
  );
}

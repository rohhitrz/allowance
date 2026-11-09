"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { CommandBar, type CommandBarHandle } from "./CommandBar";
import { Ledger, type LedgerHandle } from "./Ledger";
import { ApprovalCard, Feed, MandateCard } from "./Panels";
import { ReceiptDrawer } from "./ReceiptDrawer";
import type { Approval, Event, Mandate, Purchase, Run } from "./types";
import { Button, SectionTitle } from "./ui";

const DEMO_STEPS = [
  ["mandate", "1 · Gift mandate"],
  ["headphones", "2 · $170 headphones (hold)"],
  ["candle", "3 · $89.99 candle set"],
  ["attack", "4 · Injection: 5 gift cards"],
  ["freeze", "5 · Stop everything"],
  ["retry", "6 · Agent retries"],
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

  return (
    <div className="min-h-screen bg-zinc-50">
      <header className="sticky top-0 z-30 border-b border-zinc-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-[1600px] items-center gap-4 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-zinc-900 text-sm font-bold text-white">A</div>
            <div>
              <div className="text-[15px] font-semibold leading-tight text-zinc-900">Allowance</div>
              <div className="text-[11px] leading-tight text-zinc-500">Your agent can be fooled. Your money can&apos;t.</div>
            </div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <span className={`hidden items-center gap-1.5 text-xs sm:flex ${connected ? "text-emerald-700" : "text-zinc-400"}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${connected ? "bg-emerald-500" : "bg-zinc-300"}`} />
              {connected ? "Live" : "Reconnecting"}
            </span>
            {vault &&
              (vault.linked ? (
                <span className="hidden rounded-lg bg-[#003087]/5 px-2.5 py-1 text-xs font-medium text-[#003087] md:inline" title="Vaulted PayPal (sandbox)">
                  PayPal linked{vault.payerEmail ? ` · ${vault.payerEmail}` : ""}
                </span>
              ) : (
                <Button onClick={linkPayPal} className="hidden md:inline-flex">
                  Link PayPal
                </Button>
              ))}
            {demoMode && (
              <select
                className="rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-700"
                value=""
                onChange={(e) => e.target.value && demo(e.target.value)}
                aria-label="Demo script"
              >
                <option value="">Demo script…</option>
                {DEMO_STEPS.map(([k, label]) => (
                  <option key={k} value={k}>
                    {label}
                  </option>
                ))}
                <option value="reset">↺ Reset demo data</option>
              </select>
            )}
            <Button variant="danger" onClick={freeze} disabled={freezing || !anyActive} className="px-4 font-semibold" title="Kill switch: freeze every mandate and void open holds">
              {freezing ? "Stopping…" : "Stop everything"}
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-[1600px] grid-cols-1 gap-5 px-4 py-5 sm:px-6 lg:grid-cols-[360px_minmax(0,1fr)] xl:grid-cols-[360px_minmax(0,1fr)_300px]">
        <section className="space-y-4">
          <div>
            <SectionTitle>Tell Allowance</SectionTitle>
            <CommandBar ref={voice} onChanged={() => void loadMandates()} />
          </div>
          {approvals.map((a) => (
            <ApprovalCard key={a.id} a={a} onDecided={() => void loadApprovals()} onError={flash} />
          ))}
          <div>
            <SectionTitle>Mandates</SectionTitle>
            <div className="space-y-3">
              {mandates.length === 0 && <div className="text-sm text-zinc-500">No mandates yet.</div>}
              {mandates.map((m) => (
                <MandateCard key={m.id} m={m} run={latestRun[m.id]} onChanged={() => void loadMandates()} onError={flash} />
              ))}
            </div>
          </div>
        </section>

        <section className="flex min-w-0 flex-col">
          <SectionTitle
            right={
              <input
                value={quickFilter}
                onChange={(e) => setQuickFilter(e.target.value)}
                placeholder="Filter: blocked, gift_cards, headphones…"
                className="w-64 rounded-lg border border-zinc-300 bg-white px-2.5 py-1 text-xs outline-none focus:border-zinc-900"
              />
            }
          >
            Receipts ledger
          </SectionTitle>
          <div className="mb-3 grid grid-cols-4 gap-2">
            {(
              [
                ["Attempts", stats.total, "text-zinc-900", ""],
                ["Captured", stats.captured, "text-emerald-700", "captured"],
                ["Held", stats.held, "text-amber-700", "held"],
                ["Blocked", stats.blocked, "text-red-700", "blocked"],
              ] as const
            ).map(([label, n, color, q]) => (
              <button
                key={label}
                onClick={() => setQuickFilter((cur) => (cur === q ? "" : q))}
                className={`rounded-xl border bg-white px-3 py-2 text-left transition-colors hover:border-zinc-400 ${quickFilter === q && q ? "border-zinc-900" : "border-zinc-200"}`}
              >
                <div className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">{label}</div>
                <div className={`text-xl font-semibold tabular-nums ${color}`}>{n}</div>
              </button>
            ))}
          </div>
          <div className="h-[calc(100vh-230px)] min-h-[420px]">
            <Ledger ref={ledger} rows={purchases} mandates={mandates} onOpen={(p) => setOpenId(p.id)} quickFilter={quickFilter} />
          </div>
        </section>

        <section className="min-w-0 lg:col-span-2 xl:col-span-1">
          <SectionTitle>Live activity</SectionTitle>
          <div className="max-h-[calc(100vh-130px)] overflow-y-auto rounded-xl border border-zinc-200 bg-white p-2">
            <Feed events={events} onOpen={setOpenId} />
          </div>
        </section>
      </main>

      {toast && (
        <div
          className={`fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-xl px-4 py-2.5 text-sm shadow-lg ${
            toast.kind === "error" ? "bg-red-600 text-white" : "bg-zinc-900 text-white"
          }`}
          role="status"
        >
          {toast.text}
        </div>
      )}
      <ReceiptDrawer purchaseId={openId} version={receiptVersion} onClose={() => setOpenId(null)} />
    </div>
  );
}

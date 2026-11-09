"use client";
/**
 * Red-team report: what Claude tried against a mandate, what happened to each attempt, and an
 * independent audit of the mandate afterwards. Polls while the run is still attacking.
 */
import { useEffect, useState } from "react";
import type { RedTeamAttempt, RedTeamReport as Report } from "@/server/agent/redteam";
import { api, clock } from "./api";
import { Button } from "./ui";

const OUTCOME: Record<RedTeamAttempt["outcome"], { label: string; chip: string }> = {
  blocked: { label: "Blocked", chip: "bg-blocked-bg text-blocked" },
  refused: { label: "Refused", chip: "bg-blocked-bg text-blocked" },
  needs_human: { label: "Needs you", chip: "bg-held-bg text-held" },
  allowed: { label: "Within rules", chip: "bg-paid-bg text-paid" },
  failed: { label: "Failed", chip: "bg-neutral-bg text-ink-2" },
  breach: { label: "Rule broken", chip: "bg-blocked text-white" },
};

export function RedTeamReport({ runId, onClose, onOpenReceipt }: { runId: string | null; onClose: () => void; onOpenReceipt: (purchaseId: string) => void }) {
  const [report, setReport] = useState<Report | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!runId) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const r = await api<{ report: Report }>(`/api/runs/${runId}/report`);
        if (!live) return;
        setReport(r.report);
        setErr(null);
        if (r.report.status === "RUNNING") timer = setTimeout(load, 1200);
      } catch (e) {
        if (live) setErr((e as Error).message);
      }
    };
    void load();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [runId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!runId) return null;
  const r = report?.runId === runId ? report : null;
  const running = r?.status === "RUNNING";
  const stopped = r ? r.totals.blocked + r.totals.refused + r.totals.needsHuman : 0;
  const clean = r ? r.totals.breaches === 0 : true;

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-ink/25 backdrop-blur-[1px]" onClick={onClose}>
      <aside className="h-full w-full max-w-2xl overflow-y-auto border-l border-line bg-surface shadow-2xl" onClick={(e) => e.stopPropagation()} aria-label="Red-team report">
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-line-soft bg-surface/95 px-6 py-4 backdrop-blur">
          <div>
            <div className="font-display text-[17px] font-semibold tracking-[-0.01em] text-ink">Red-team report</div>
            <div className="text-[13px] text-muted">
              Claude was told to break this mandate{r ? ` (${r.model})` : ""}. It chose every attack itself.
            </div>
          </div>
          <Button variant="ghost" onClick={onClose} aria-label="Close">
            ✕
          </Button>
        </div>

        {err && <div className="mx-6 mt-4 rounded-lg bg-blocked-bg px-3 py-2 text-sm text-blocked">{err}</div>}
        {!r ? (
          <div className="p-6 text-sm text-muted">Starting the attack…</div>
        ) : (
          <div className="space-y-7 px-6 py-6">
            <section className={`rounded-2xl border p-5 ${clean ? "border-[#bfe3d3] bg-paid-bg" : "border-blocked bg-blocked-bg"}`}>
              <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
                <Stat n={r.totals.attempts} label={r.totals.attempts === 1 ? "attack" : "attacks"} />
                <Stat n={stopped} label="stopped" />
                <Stat n={r.totals.breaches} label="rules broken" tone={clean ? "text-paid" : "text-blocked"} />
                {running && (
                  <span className="mb-1.5 flex items-center gap-2 text-[13px] font-medium text-ink-2">
                    <span className="relative flex h-2 w-2">
                      <span className="absolute inset-0 animate-ping rounded-full bg-blocked/50" />
                      <span className="relative h-2 w-2 rounded-full bg-blocked" />
                    </span>
                    Attacking now
                  </span>
                )}
              </div>
              <p className="mt-3 text-[14px] leading-relaxed text-ink-2">
                {clean
                  ? running
                    ? "Nothing has got through so far."
                    : "Nothing got through. Every attempt went through the same checks and the same PayPal sandbox as a real agent."
                  : "Something a rule forbids happened. See the attempts and the audit below."}
                {r.totals.allowed > 0 && ` ${r.totals.allowed} purchase${r.totals.allowed === 1 ? " was" : "s were"} inside every rule, so ${r.totals.allowed === 1 ? "it was" : "they were"} paid as normal.`}
              </p>
            </section>

            <section>
              <h3 className="mb-2 font-display text-[15px] font-semibold text-ink">Independent audit</h3>
              <p className="mb-3 text-[13px] text-muted">
                Recomputed from the purchase records after the attack. It shares no code with the policy engine, so it would catch the engine being wrong. It checks exactly the rules listed here.
              </p>
              <ul className="divide-y divide-line-soft rounded-xl border border-line">
                {r.audit.checks.map((c) => (
                  <li key={c.name} className="flex items-start gap-3 px-3.5 py-2.5 text-[14px]">
                    <span
                      className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${c.ok ? "bg-paid-bg text-paid" : "bg-blocked text-white"}`}
                      aria-label={c.ok ? "Holds" : "Broken"}
                    >
                      {c.ok ? "✓" : "✕"}
                    </span>
                    <div className="min-w-0">
                      <div className="font-medium text-ink">{c.name}</div>
                      <div className="text-[13px] text-muted">{c.detail}</div>
                    </div>
                  </li>
                ))}
              </ul>
              {r.audit.notChecked?.length ? (
                <p className="mt-2 text-[12.5px] text-muted">Not covered by the audit: {r.audit.notChecked.join("; ")}.</p>
              ) : null}
            </section>

            <section>
              <h3 className="mb-3 font-display text-[15px] font-semibold text-ink">What it tried</h3>
              {r.attempts.length === 0 ? (
                <p className="text-[14px] text-muted">{running ? "Looking through the catalog for something to exploit…" : "It made no attempts."}</p>
              ) : (
                <ol className="space-y-2.5">
                  {r.attempts.map((a, i) => (
                    <li key={i} className="rounded-xl border border-line px-4 py-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-[12px] font-medium uppercase tracking-wide text-faint">
                            Attack {i + 1} · {clock(a.at)}
                          </div>
                          <div className="mt-0.5 font-medium text-ink first-letter:uppercase">{a.tactic}</div>
                        </div>
                        <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-[12px] font-semibold leading-5 ${OUTCOME[a.outcome].chip}`}>{OUTCOME[a.outcome].label}</span>
                      </div>
                      <div className="num mt-1.5 text-[14px] text-ink-2">{a.what}</div>
                      <div className="mt-1 text-[13px] leading-relaxed text-muted">{a.detail}</div>
                      {a.purchaseId && (
                        <button onClick={() => onOpenReceipt(a.purchaseId!)} className="mt-2 text-[13px] font-semibold text-accent hover:underline">
                          Open decision receipt
                        </button>
                      )}
                    </li>
                  ))}
                </ol>
              )}
            </section>

            {r.verdict && (
              <section>
                <h3 className="mb-2 font-display text-[15px] font-semibold text-ink">The attacker&apos;s own summary</h3>
                <blockquote className="whitespace-pre-wrap rounded-xl bg-sunken px-4 py-3 text-[14px] leading-relaxed text-ink-2">{r.verdict}</blockquote>
              </section>
            )}
          </div>
        )}
      </aside>
    </div>
  );
}

function Stat({ n, label, tone = "text-ink" }: { n: number; label: string; tone?: string }) {
  return (
    <div className="leading-none">
      <div className={`num font-display text-[40px] font-semibold tracking-[-0.03em] ${tone}`}>{n}</div>
      <div className="mt-1 text-[13px] font-medium text-ink-2">{label}</div>
    </div>
  );
}

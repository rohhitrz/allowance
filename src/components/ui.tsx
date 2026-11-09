import type { ButtonHTMLAttributes, ReactNode } from "react";

type Tone = "paid" | "held" | "blocked" | "frozen" | "info" | "neutral";

const TONE: Record<Tone, { chip: string; dot: string }> = {
  paid: { chip: "bg-paid-bg text-paid", dot: "bg-paid" },
  held: { chip: "bg-held-bg text-held", dot: "bg-held" },
  blocked: { chip: "bg-blocked-bg text-blocked", dot: "bg-blocked" },
  frozen: { chip: "bg-frozen-bg text-frozen", dot: "bg-frozen" },
  info: { chip: "bg-[#ebeffd] text-accent", dot: "bg-accent" },
  neutral: { chip: "bg-neutral-bg text-ink-2", dot: "bg-faint" },
};

const STATUS: Record<string, [Tone, string]> = {
  CAPTURED: ["paid", "Paid"],
  BLOCKED: ["blocked", "Blocked"],
  HELD: ["held", "Held"],
  VOIDED: ["neutral", "Voided"],
  FAILED: ["blocked", "Failed"],
  REFUNDED: ["frozen", "Refunded"],
  RESERVED: ["info", "Reserved"],
  AUTHORIZED: ["info", "Authorized"],
  PROPOSED: ["neutral", "Proposed"],
  // mandates
  ACTIVE: ["paid", "Active"],
  DRAFT: ["info", "Draft"],
  FROZEN: ["frozen", "Frozen"],
  EXPIRED: ["neutral", "Expired"],
  CANCELLED: ["neutral", "Cancelled"],
  // runs / approvals
  RUNNING: ["info", "Running"],
  WAITING_APPROVAL: ["held", "Waiting"],
  DONE: ["neutral", "Done"],
  STOPPED: ["neutral", "Stopped"],
  PENDING: ["held", "Pending"],
  APPROVED: ["paid", "Approved"],
  REJECTED: ["neutral", "Rejected"],
};

export function statusTone(status: string): Tone {
  return STATUS[status]?.[0] ?? "neutral";
}

export function StatusChip({ status, className = "" }: { status: string; className?: string }) {
  const [tone, label] = STATUS[status] ?? (["neutral", status.toLowerCase()] as [Tone, string]);
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[12px] font-semibold leading-5 ${TONE[tone].chip} ${className}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${TONE[tone].dot}`} aria-hidden />
      {label}
    </span>
  );
}

export function RulePill({ rule, kind }: { rule: string; kind: "hard" | "soft" }) {
  return (
    <span
      title={kind === "hard" ? "Hard rule: always blocks" : "Soft rule: asks you first"}
      className={`inline-flex items-center rounded-md px-1.5 py-0.5 font-mono text-[11px] leading-4 ${
        kind === "hard" ? "bg-blocked-bg text-blocked" : "bg-held-bg text-held"
      }`}
    >
      {rule}
    </span>
  );
}

type Variant = "primary" | "secondary" | "danger" | "ghost" | "approve";
const VARIANT: Record<Variant, string> = {
  primary: "bg-ink text-white shadow-[0_1px_0_rgba(12,27,51,0.2)] hover:bg-[#1b2c4a] disabled:bg-faint",
  secondary: "bg-surface text-ink ring-1 ring-inset ring-line hover:bg-sunken hover:ring-[#c9d0db] disabled:text-faint",
  danger: "bg-blocked text-white hover:bg-[#9a1d14] disabled:bg-[#e3a5a0]",
  approve: "bg-paid text-white hover:bg-[#086445] disabled:bg-[#9bcdb9]",
  ghost: "text-ink-2 hover:bg-neutral-bg hover:text-ink disabled:text-faint",
};

export function Button({ variant = "secondary", className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      {...props}
      className={`inline-flex h-9 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-3.5 text-[14px] font-semibold transition-colors disabled:cursor-not-allowed ${VARIANT[variant]} ${className}`}
    />
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-2xl border border-line bg-surface ${className}`}>{children}</div>;
}

export function SectionTitle({ children, right, hint }: { children: ReactNode; right?: ReactNode; hint?: ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
      <div>
        <h2 className="font-display text-[17px] font-semibold tracking-[-0.01em] text-ink">{children}</h2>
        {hint && <p className="mt-0.5 text-[13px] text-muted">{hint}</p>}
      </div>
      {right}
    </div>
  );
}

export function Tag({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "blocked" }) {
  return (
    <span
      className={`inline-flex items-center rounded-md px-2 py-0.5 text-[12px] leading-5 ${
        tone === "blocked" ? "bg-blocked-bg text-blocked" : "bg-neutral-bg text-ink-2"
      }`}
    >
      {children}
    </span>
  );
}

/** Logo: a navy tile with a spend meter that stops short of its limit. */
export function BrandMark({ size = 36 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 36 36" aria-hidden className="shrink-0">
      <rect width="36" height="36" rx="10" fill="#0c1b33" />
      <rect x="8" y="20" width="20" height="5" rx="2.5" fill="#ffffff" opacity="0.18" />
      <rect x="8" y="20" width="13" height="5" rx="2.5" fill="#7fd3b0" />
      <rect x="23.5" y="17" width="1.6" height="11" rx="0.8" fill="#ffffff" />
      <path d="M11 15.5 18 9l7 6.5" fill="none" stroke="#ffffff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

import type { ButtonHTMLAttributes, ReactNode } from "react";

const STATUS_STYLE: Record<string, string> = {
  CAPTURED: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  BLOCKED: "bg-red-50 text-red-700 ring-red-600/25",
  HELD: "bg-amber-50 text-amber-800 ring-amber-600/30",
  VOIDED: "bg-zinc-100 text-zinc-600 ring-zinc-500/20",
  FAILED: "bg-red-50 text-red-700 ring-red-600/25",
  REFUNDED: "bg-sky-50 text-sky-700 ring-sky-600/20",
  RESERVED: "bg-indigo-50 text-indigo-700 ring-indigo-600/20",
  AUTHORIZED: "bg-indigo-50 text-indigo-700 ring-indigo-600/20",
  PROPOSED: "bg-zinc-100 text-zinc-600 ring-zinc-500/20",
  // mandates
  ACTIVE: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  DRAFT: "bg-indigo-50 text-indigo-700 ring-indigo-600/20",
  FROZEN: "bg-sky-50 text-sky-800 ring-sky-600/30",
  EXPIRED: "bg-zinc-100 text-zinc-600 ring-zinc-500/20",
  CANCELLED: "bg-zinc-100 text-zinc-600 ring-zinc-500/20",
  // runs / approvals
  RUNNING: "bg-indigo-50 text-indigo-700 ring-indigo-600/20",
  WAITING_APPROVAL: "bg-amber-50 text-amber-800 ring-amber-600/30",
  DONE: "bg-zinc-100 text-zinc-700 ring-zinc-500/20",
  STOPPED: "bg-zinc-100 text-zinc-700 ring-zinc-500/20",
  PENDING: "bg-amber-50 text-amber-800 ring-amber-600/30",
  APPROVED: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  REJECTED: "bg-zinc-100 text-zinc-600 ring-zinc-500/20",
};

export function StatusChip({ status, className = "" }: { status: string; className?: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-semibold tracking-wide ring-1 ring-inset ${STATUS_STYLE[status] ?? STATUS_STYLE.PROPOSED} ${className}`}
    >
      {status === "WAITING_APPROVAL" ? "WAITING" : status}
    </span>
  );
}

export function RulePill({ rule, kind }: { rule: string; kind: "hard" | "soft" }) {
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-px font-mono text-[10.5px] ${
        kind === "hard" ? "bg-red-100 text-red-800" : "bg-amber-100 text-amber-900"
      }`}
    >
      {rule}
    </span>
  );
}

type Variant = "primary" | "secondary" | "danger" | "ghost" | "approve";
const VARIANT: Record<Variant, string> = {
  primary: "bg-zinc-900 text-white hover:bg-zinc-700 disabled:bg-zinc-400",
  secondary: "bg-white text-zinc-800 ring-1 ring-inset ring-zinc-300 hover:bg-zinc-50 disabled:text-zinc-400",
  danger: "bg-red-600 text-white hover:bg-red-500 disabled:bg-red-300",
  approve: "bg-emerald-600 text-white hover:bg-emerald-500 disabled:bg-emerald-300",
  ghost: "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900",
};

export function Button({ variant = "secondary", className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      {...props}
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed ${VARIANT[variant]} ${className}`}
    />
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-xl border border-zinc-200 bg-white shadow-sm ${className}`}>{children}</div>;
}

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-2 flex items-center justify-between">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">{children}</h2>
      {right}
    </div>
  );
}

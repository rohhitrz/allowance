"use client";
import { useState } from "react";

export function LoginForm() {
  const [passcode, setPasscode] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    const res = await fetch("/api/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ passcode }) });
    setBusy(false);
    if (!res.ok) return setErr("Wrong passcode");
    const next = new URLSearchParams(window.location.search).get("next");
    window.location.href = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
  };
  return (
    <form onSubmit={submit} className="mt-7 space-y-3">
      <label htmlFor="passcode" className="block text-[14px] font-semibold text-ink">
        Passcode
      </label>
      <input
        id="passcode"
        type="password"
        autoFocus
        value={passcode}
        onChange={(e) => setPasscode(e.target.value)}
        className="h-11 w-full rounded-xl border border-line bg-surface px-3.5 text-[15px] text-ink outline-none focus:border-accent focus:ring-4 focus:ring-accent/15"
      />
      {err && <div role="alert" className="text-[14px] text-blocked">{err}. Check it and try again.</div>}
      <button disabled={busy || !passcode} className="h-11 w-full rounded-xl bg-ink text-[15px] font-semibold text-white transition-colors hover:bg-[#1b2c4a] disabled:bg-faint">
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}

"use client";
/**
 * Push-to-talk (browser SpeechRecognition + speechSynthesis) and a typed fallback.
 * Both go through the same voice tools on the server (/api/voice/local), recorded as user:voice.
 * Routing is deterministic: after a question ("Approve or reject?", "Should I start?") the next
 * answer is read as that answer. Only an explicit "approve" approves; anything else rejects.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { api } from "./api";
import type { Approval } from "./types";
import { Button } from "./ui";

type Awaiting = { kind: "approval"; approvalId: string } | { kind: "confirm"; mandateId: string } | null;
type Line = { who: "you" | "allowance"; text: string };

type SR = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
};

export type CommandBarHandle = { announceApproval: (a: Approval) => void };

const tool = <T,>(name: string, args: Record<string, unknown> = {}) =>
  api<{ result: T }>("/api/voice/local", { body: { tool: name, args } }).then((r) => r.result);

const isApprove = (t: string) => /\bapprove(d)?\b|\byes,? approve\b/i.test(t) && !/\b(don'?t|do not|not|never|reject)\b/i.test(t);
const isYes = (t: string) => /^\s*(yes|yeah|yep|sure|confirm|go|start|do it|ok(ay)?)\b/i.test(t);

export const CommandBar = forwardRef<CommandBarHandle, { onChanged: () => void }>(function CommandBar({ onChanged }, ref) {
  const [text, setText] = useState("");
  const [interim, setInterim] = useState("");
  const [listening, setListening] = useState(false);
  const [busy, setBusy] = useState(false);
  const [speakReplies, setSpeakReplies] = useState(true);
  const [log, setLog] = useState<Line[]>([]);
  const [supported, setSupported] = useState(false);
  const awaiting = useRef<Awaiting>(null);
  const rec = useRef<SR | null>(null);
  const speakRef = useRef(speakReplies);
  speakRef.current = speakReplies;

  useEffect(() => {
    const w = window as unknown as { SpeechRecognition?: new () => SR; webkitSpeechRecognition?: new () => SR };
    setSupported(Boolean(w.SpeechRecognition ?? w.webkitSpeechRecognition));
  }, []);

  const say = useCallback((t: string) => {
    setLog((l) => [...l.slice(-7), { who: "allowance", text: t }]);
    if (speakRef.current && typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(t);
      u.rate = 1.05;
      window.speechSynthesis.speak(u);
    }
  }, []);

  useImperativeHandle(ref, () => ({
    announceApproval(a) {
      awaiting.current = { kind: "approval", approvalId: a.id };
      say(a.prompt);
    },
  }));

  const handle = useCallback(
    async (utterance: string) => {
      const t = utterance.trim();
      if (!t) return;
      setLog((l) => [...l.slice(-7), { who: "you", text: t }]);
      setBusy(true);
      try {
        const wait = awaiting.current;
        awaiting.current = null;

        if (/\b(stop everything|stop|freeze|kill switch|halt)\b/i.test(t) && !(wait?.kind === "confirm" && isYes(t))) {
          const r = await tool<{ message: string }>("freeze_all");
          say(r.message);
        } else if (wait?.kind === "approval") {
          const r = await tool<{ message: string }>("decide_approval", { approvalId: wait.approvalId, decision: isApprove(t) ? "approve" : "reject" });
          say(r.message);
        } else if (wait?.kind === "confirm") {
          if (isYes(t)) {
            const r = await tool<{ message: string }>("confirm_mandate", { mandateId: wait.mandateId });
            say(r.message);
          } else say("Okay. I left it as a draft; nothing will be bought.");
        } else if (/^\s*(approve|reject)\b/i.test(t)) {
          const pending = await tool<{ approvalId?: string; prompt?: string; none?: boolean }>("get_pending_approval");
          if (!pending.approvalId) say("Nothing is waiting for you.");
          else {
            const r = await tool<{ message: string }>("decide_approval", { approvalId: pending.approvalId, decision: isApprove(t) ? "approve" : "reject" });
            say(r.message);
          }
        } else if (/\b(refund|return it|send it back)\b/i.test(t)) {
          const r = await tool<{ message: string }>("refund");
          say(r.message);
        } else if (/\b(what('?s| is)? (happening|happened)|activity|status|what did you buy)\b/i.test(t)) {
          const r = await tool<{ items: { what: string; status: string }[] }>("list_activity", { limit: 3 });
          say(r.items.length ? r.items.map((i) => `${i.what}: ${i.status}.`).join(" ") : "Nothing yet.");
        } else if (/\b(pending|waiting|anything to approve)\b/i.test(t)) {
          const pending = await tool<{ approvalId?: string; prompt?: string; message?: string }>("get_pending_approval");
          if (pending.approvalId) {
            awaiting.current = { kind: "approval", approvalId: pending.approvalId };
            say(pending.prompt!);
          } else say(pending.message ?? "Nothing is waiting for you.");
        } else {
          const r = await tool<{ mandateId: string; summary: string }>("create_mandate", { text: t });
          awaiting.current = { kind: "confirm", mandateId: r.mandateId };
          say(r.summary);
        }
      } catch (e) {
        say(`Sorry, that didn't work: ${(e as Error).message}`);
      } finally {
        setBusy(false);
        onChanged();
      }
    },
    [onChanged, say],
  );

  const toggleMic = () => {
    if (listening) {
      rec.current?.stop();
      return;
    }
    const w = window as unknown as { SpeechRecognition?: new () => SR; webkitSpeechRecognition?: new () => SR };
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!Ctor) return;
    window.speechSynthesis?.cancel();
    const r = new Ctor();
    r.lang = "en-US";
    r.interimResults = true;
    r.continuous = false;
    let finalText = "";
    r.onresult = (e) => {
      let live = "";
      for (let i = 0; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) finalText += res[0].transcript;
        else live += res[0].transcript;
      }
      setInterim(finalText + live);
    };
    r.onerror = (e) => {
      if (e.error !== "no-speech" && e.error !== "aborted") say(`Microphone error: ${e.error}`);
    };
    r.onend = () => {
      setListening(false);
      setInterim("");
      if (finalText.trim()) void handle(finalText);
    };
    rec.current = r;
    setListening(true);
    r.start();
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const t = text;
    setText("");
    void handle(t);
  };

  return (
    <div>
      <form onSubmit={submit} className="flex items-stretch gap-2">
        <button
          type="button"
          onClick={toggleMic}
          disabled={!supported || busy}
          title={supported ? "Push to talk" : "Speech recognition isn't available in this browser; type instead"}
          className={`relative flex w-12 shrink-0 items-center justify-center rounded-xl text-white transition-colors disabled:cursor-not-allowed disabled:bg-zinc-300 ${
            listening ? "bg-red-600" : "bg-zinc-900 hover:bg-zinc-700"
          }`}
          aria-label={listening ? "Stop listening" : "Push to talk"}
        >
          {listening && <span className="absolute inset-0 animate-ping rounded-xl bg-red-500/40" />}
          <svg viewBox="0 0 24 24" className="relative h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <rect x="9" y="3" width="6" height="11" rx="3" />
            <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
          </svg>
        </button>
        <input
          value={listening ? interim : text}
          onChange={(e) => setText(e.target.value)}
          readOnly={listening}
          placeholder={listening ? "Listening…" : "“Find a birthday gift for my sister, around $150, never more than $200…”"}
          className="min-w-0 flex-1 rounded-xl border border-zinc-300 bg-white px-3.5 py-2.5 text-sm outline-none placeholder:text-zinc-400 focus:border-zinc-900 focus:ring-2 focus:ring-zinc-900/10"
        />
        <Button type="submit" variant="primary" disabled={busy || listening || !text.trim()} className="rounded-xl px-4">
          {busy ? "…" : "Send"}
        </Button>
      </form>
      <div className="mt-2 flex items-center justify-between text-xs text-zinc-500">
        <span>Say a mandate, “approve”, “reject”, “what happened?”, “return it” or “stop everything”.</span>
        <label className="flex cursor-pointer items-center gap-1.5">
          <input type="checkbox" checked={speakReplies} onChange={(e) => setSpeakReplies(e.target.checked)} className="accent-zinc-900" />
          Speak replies
        </label>
      </div>
      {log.length > 0 && (
        <div className="mt-3 space-y-1.5 rounded-xl bg-zinc-50 px-3 py-2.5 text-sm">
          {log.map((l, i) => (
            <div key={i} className={l.who === "you" ? "text-zinc-500" : "text-zinc-900"}>
              <span className="mr-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-zinc-400">{l.who}</span>
              {l.text}
            </div>
          ))}
        </div>
      )}
    </div>
  );
});

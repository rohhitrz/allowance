"use client";
/**
 * Push-to-talk (browser SpeechRecognition + speechSynthesis) and a typed fallback.
 * Both go through the same voice tools on the server (/api/voice/local), recorded as user:voice.
 * Routing is deterministic and lives in ./intent.ts (tested): after a question ("Approve or
 * reject?", "Should I start?") the next answer is read as that answer. Only an explicit
 * "approve" approves; anything else rejects.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { api } from "./api";
import { interpret, type Awaiting } from "./intent";
import type { Approval } from "./types";
import { Button } from "./ui";

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

export type CommandBarHandle = { announceApproval: (a: Approval) => void; announce: (text: string) => void };

/** Keep listening through pauses; send after this much silence, or when the mic is tapped again. */
const SILENCE_MS = 3500;
const MAX_LISTEN_MS = 60_000;

const tool = <T,>(name: string, args: Record<string, unknown> = {}) =>
  api<{ result: T }>("/api/voice/local", { body: { tool: name, args } }).then((r) => r.result);


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
  const finishListening = useRef<(() => void) | null>(null);
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
    announce(t) {
      say(t);
    },
  }));

  const handle = useCallback(
    async (utterance: string) => {
      const t = utterance.trim();
      if (!t) return;
      setLog((l) => [...l.slice(-7), { who: "you", text: t }]);
      setBusy(true);
      try {
        const intent = interpret(t, awaiting.current);
        awaiting.current = null;
        // After a decision, read out the next hold (if any) so the next answer is about that one.
        const readNextHold = async (prefix: string) => {
          const next = await tool<{ approvalId?: string; prompt?: string }>("get_pending_approval");
          if (next.approvalId && next.prompt) {
            awaiting.current = { kind: "approval", approvalId: next.approvalId };
            say(`${prefix} Next: ${next.prompt}`);
          } else say(prefix);
        };

        switch (intent.kind) {
          case "freeze": {
            const r = await tool<{ message: string }>("freeze_all");
            say(r.message);
            break;
          }
          case "decide": {
            // With no id the server decides only if exactly one hold is waiting; it never guesses.
            const r = await tool<{ status: string; message: string }>("decide_approval", {
              decision: intent.decision,
              ...(intent.approvalId ? { approvalId: intent.approvalId } : {}),
            });
            await readNextHold(r.message);
            break;
          }
          case "confirm": {
            const r = await tool<{ message: string }>("confirm_mandate", intent.mandateId ? { mandateId: intent.mandateId } : {});
            say(r.message);
            break;
          }
          case "keep_draft":
            // Remember the draft: a later "start now" means this one, not a new mandate.
            awaiting.current = { kind: "draft", mandateId: intent.mandateId };
            say("Okay, it's still a draft and nothing will be bought. Say “start now” when you're ready, or tell me what to change.");
            break;
          case "refund": {
            const r = await tool<{ message: string }>("refund");
            say(r.message);
            break;
          }
          case "activity": {
            const r = await tool<{ items: { what: string; status: string }[] }>("list_activity", { limit: 3 });
            say(r.items.length ? r.items.map((i) => `${i.what}: ${i.status}.`).join(" ") : "Nothing yet.");
            break;
          }
          case "pending": {
            const pending = await tool<{ approvalId?: string; prompt?: string; message?: string }>("get_pending_approval");
            if (pending.approvalId) {
              awaiting.current = { kind: "approval", approvalId: pending.approvalId };
              say(pending.prompt!);
            } else say(pending.message ?? "Nothing is waiting for you.");
            break;
          }
          case "mandate": {
            const r = await tool<{ mandateId: string; summary: string }>("create_mandate", { text: intent.text });
            awaiting.current = { kind: "confirm", mandateId: r.mandateId };
            say(r.summary);
            break;
          }
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
      finishListening.current?.();
      return;
    }
    const w = window as unknown as { SpeechRecognition?: new () => SR; webkitSpeechRecognition?: new () => SR };
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!Ctor) return;
    window.speechSynthesis?.cancel();
    const r = new Ctor();
    r.lang = "en-US";
    r.interimResults = true;
    // Continuous: Chrome would otherwise end at the first short pause and cut the sentence off.
    r.continuous = true;
    const startedAt = Date.now();
    let committed = ""; // text from earlier recognition sessions (Chrome still ends one now and then)
    let sessionFinal = "";
    let done = false;
    let silence: ReturnType<typeof setTimeout> | undefined;
    const joined = () => `${committed} ${sessionFinal}`.replace(/\s+/g, " ").trim();

    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(silence);
      r.stop(); // onend sends what was heard
    };
    finishListening.current = finish;

    r.onresult = (e) => {
      let fin = "";
      let live = "";
      for (let i = 0; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) fin += res[0].transcript;
        else live += res[0].transcript;
      }
      sessionFinal = fin;
      setInterim(`${joined()} ${live}`.trim());
      clearTimeout(silence);
      silence = setTimeout(finish, SILENCE_MS);
    };
    r.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") done = true;
      if (e.error !== "no-speech" && e.error !== "aborted") say(`Microphone error: ${e.error}`);
    };
    r.onend = () => {
      committed = joined();
      sessionFinal = "";
      if (!done && Date.now() - startedAt < MAX_LISTEN_MS) {
        try {
          r.start(); // the browser stopped on its own: keep listening
          return;
        } catch {
          /* fall through and send what we have */
        }
      }
      done = true;
      clearTimeout(silence);
      finishListening.current = null;
      setListening(false);
      setInterim("");
      if (committed) void handle(committed);
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
    <div className="rounded-2xl border border-line bg-surface p-2 shadow-[0_1px_2px_rgba(12,27,51,0.04)] focus-within:border-[#b9c6e8] focus-within:ring-4 focus-within:ring-accent/10">
      <form onSubmit={submit} className="flex items-stretch gap-2">
        <button
          type="button"
          onClick={toggleMic}
          disabled={!supported || busy}
          title={supported ? (listening ? "Tap to send" : "Tap to talk") : "Speech recognition isn't available in this browser; type instead"}
          className={`relative flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-white transition-colors disabled:cursor-not-allowed disabled:bg-faint ${
            listening ? "bg-blocked" : "bg-ink hover:bg-[#1b2c4a]"
          }`}
          aria-label={listening ? "Stop listening and send" : "Tap to talk"}
        >
          {listening && <span className="absolute inset-0 animate-ping rounded-xl bg-blocked/40" />}
          <svg viewBox="0 0 24 24" className="relative h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <rect x="9" y="3" width="6" height="11" rx="3" />
            <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
          </svg>
        </button>
        <label className="min-w-0 flex-1">
          <span className="sr-only">Tell Allowance what to do</span>
          <input
            value={listening ? interim : text}
            onChange={(e) => setText(e.target.value)}
            readOnly={listening}
            placeholder={listening ? "Listening… tap the mic when you're done" : "Find a birthday gift for my sister, around $150"}
            className="h-11 w-full bg-transparent px-1.5 text-[15px] text-ink outline-none placeholder:text-faint"
          />
        </label>
        <Button type="submit" variant="primary" disabled={busy || listening || !text.trim()} className="h-11 rounded-xl px-4">
          {busy ? "Working…" : "Send"}
        </Button>
      </form>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-1.5 pb-1 pt-2 text-[12.5px] text-muted">
        <span>Try “approve”, “reject”, “what happened?”, “return it” or “stop everything”.</span>
        <label className="flex cursor-pointer select-none items-center gap-1.5 text-ink-2">
          <input type="checkbox" checked={speakReplies} onChange={(e) => setSpeakReplies(e.target.checked)} className="h-3.5 w-3.5 accent-[#0c1b33]" />
          Speak replies
        </label>
      </div>
      {log.length > 0 && (
        <div className="mt-1 space-y-2 border-t border-line-soft px-1.5 pb-1 pt-3" aria-live="polite">
          {log.map((l, i) =>
            l.who === "you" ? (
              <div key={i} className="flex justify-end">
                <div className="max-w-[85%] rounded-2xl rounded-br-md bg-neutral-bg px-3 py-1.5 text-[14px] leading-snug text-ink-2">{l.text}</div>
              </div>
            ) : (
              <div key={i} className="flex gap-2">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-ink text-[10px] font-bold text-white" aria-label="Allowance">
                  A
                </span>
                <div className="max-w-[90%] text-[14px] leading-snug text-ink">{l.text}</div>
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
});

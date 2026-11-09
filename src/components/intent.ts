/**
 * What a spoken or typed sentence means to the command bar. Pure and deterministic (no LLM),
 * so it can be tested: the wrong reading here could approve a payment or freeze everything.
 *
 * Order matters:
 *   1. a clear stop command always wins (freezing is the safe direction)
 *   2. if we just asked a question, the sentence is the answer to that question
 *   3. otherwise it's a command, and anything unrecognised is a new mandate
 * Only an explicit, un-negated "approve" approves. Anything else said to a hold rejects it.
 */
export type Awaiting =
  | { kind: "approval"; approvalId: string }
  | { kind: "confirm"; mandateId: string }
  /** The user said "no" to starting this draft. A later bare "start now" still means this one. */
  | { kind: "draft"; mandateId: string }
  | null;

export type Intent =
  | { kind: "freeze" }
  | { kind: "decide"; decision: "approve" | "reject"; approvalId?: string }
  /** No mandateId: the server starts the user's only draft, and refuses if there are several. */
  | { kind: "confirm"; mandateId?: string }
  | { kind: "keep_draft"; mandateId: string }
  | { kind: "refund" }
  | { kind: "activity" }
  | { kind: "pending" }
  | { kind: "mandate"; text: string };

const NEGATION = String.raw`(?:don'?t|do not|not|never|won'?t|shouldn'?t)`;
const negated = (verb: string) => new RegExp(String.raw`\b${NEGATION}\s+(?:\w+\s+){0,3}${verb}`, "i");

/** "approve", "yes, approve it". Not "don't approve", not "approve… no, reject". */
export function isApprove(t: string): boolean {
  return /\bapprove[ds]?\b/i.test(t) && !negated("approve").test(t) && !/\b(reject|decline|deny|cancel)\b/i.test(t);
}

/**
 * A stop command: "stop", "stop everything", "please stop it now", "freeze it all", "kill switch".
 *
 * Freezing is the safe direction, but freezing by accident still breaks what the user asked
 * for, so a stop word alone is not enough. It counts only when
 *   - it comes with an unmistakable object ("stop everything", "freeze it all"), or
 *   - the whole sentence is the command and nothing else ("stop", "ok stop it now").
 * So these are shopping requests, not stops: "freeze-dried strawberries under $20",
 * "Stop and Shop gift card", "a rubber door stop". Negated forms ("approve, don't stop") never count.
 */
const STOP_WORD = "(?:stop|freeze|halt)";
const FILLER = "(?:please|ok(?:ay)?|now|just|right|immediately|all|it|this|that|the|my|any|every|agents?|bots?|shopping|buying|spending|paying|money|purchases?|purchasing|orders?|ordering|payments?|transactions?|charges?|checkouts?)";
const WHOLE_SENTENCE_STOP = new RegExp(String.raw`^\W*(?:${FILLER}\W+)*${STOP_WORD}(?:\W+${FILLER})*\W*$`, "i");

export function isStop(t: string): boolean {
  if (negated(STOP_WORD).test(t)) return false;
  return /\b(?:stop|freeze|halt) (?:everything|it all|all of it)\b|\bkill switch\b/i.test(t) || WHOLE_SENTENCE_STOP.test(t);
}

export const isYes = (t: string) => /^\W*(yes|yeah|yep|sure|confirm|go|start|do it|ok(ay)?)\b/i.test(t);

/**
 * A short go-ahead with nothing else in it: "start now", "yes go ahead", "ok start shopping".
 * Never a sentence with an amount or a product in it, which is a new mandate.
 */
export function isBareStart(t: string): boolean {
  if (/[\d$]/.test(t) || t.trim().split(/\s+/).length > 6) return false;
  return /^\W*(?:(?:yes|yeah|yep|ok(?:ay)?|sure|please|now|then)\W+)*(?:start|go(?: ahead)?|begin|confirm|do it|buy it|run it)\b/i.test(t);
}

export function interpret(utterance: string, awaiting: Awaiting): Intent {
  const t = utterance.trim();
  if (isStop(t)) return { kind: "freeze" };
  if (awaiting?.kind === "approval") {
    return { kind: "decide", decision: isApprove(t) ? "approve" : "reject", approvalId: awaiting.approvalId };
  }
  if (awaiting?.kind === "confirm") {
    return isYes(t) ? { kind: "confirm", mandateId: awaiting.mandateId } : { kind: "keep_draft", mandateId: awaiting.mandateId };
  }
  if (isBareStart(t)) return awaiting?.kind === "draft" ? { kind: "confirm", mandateId: awaiting.mandateId } : { kind: "confirm" };
  // No question was asked. The server decides only if exactly one hold is waiting.
  if (/^\W*(approve|reject)\b/i.test(t)) return { kind: "decide", decision: isApprove(t) ? "approve" : "reject" };
  if (/\b(refund|return it|send it back)\b/i.test(t)) return { kind: "refund" };
  if (/\b(what('?s| is)? (happening|happened)|activity|status|what did you buy)\b/i.test(t)) return { kind: "activity" };
  if (/\b(pending|waiting|anything to approve)\b/i.test(t)) return { kind: "pending" };
  return { kind: "mandate", text: t };
}

import { describe, expect, it } from "vitest";
import { interpret, isApprove, isStop, type Awaiting } from "./intent";

const hold: Awaiting = { kind: "approval", approvalId: "apr_1" };
const draft: Awaiting = { kind: "confirm", mandateId: "man_1" };

describe("command bar intent", () => {
  it("“approve, don't stop” approves the hold and does not freeze", () => {
    expect(interpret("Approve, don't stop", hold)).toEqual({ kind: "decide", decision: "approve", approvalId: "apr_1" });
    expect(interpret("approve it and do not stop shopping", hold).kind).toBe("decide");
  });

  it.each(["stop", "Stop everything", "please stop", "stop it now", "freeze it all", "kill switch", "ok, stop everything", "Stop!", "ok stop shopping", "freeze all", "halt"])(
    "“%s” freezes, even while a question is open",
    (t) => {
      expect(interpret(t, null)).toEqual({ kind: "freeze" });
      expect(interpret(t, hold)).toEqual({ kind: "freeze" });
      expect(interpret(t, draft)).toEqual({ kind: "freeze" });
    },
  );

  it.each([
    "don't stop",
    "never stop",
    "A rubber door stop for my office, under $20",
    "Find a bus stop poster, around $30",
    "freeze-dried strawberries under $20",
    "Freeze dried fruit for hiking, around $15",
    "Stop and Shop gift card for my mum, $50",
    "Stop motion animation kit for my nephew, under $40",
    "Halt and Catch Fire box set, around $30",
    "stop buying coffee beans and get tea instead, $20 a week",
  ])(
    "“%s” is not a stop command",
    (t) => expect(isStop(t)).toBe(false),
  );

  it("only a clear approve approves; everything else said to a hold rejects it", () => {
    const d = (t: string) => interpret(t, hold);
    for (const t of ["approve", "Yes, approve it", "approved"]) expect(d(t)).toMatchObject({ kind: "decide", decision: "approve" });
    for (const t of ["reject", "no", "don't approve", "I do not want to approve that", "approve... no wait, reject", "hmm", "yes"]) {
      expect(d(t)).toMatchObject({ kind: "decide", decision: "reject", approvalId: "apr_1" });
    }
    expect(isApprove("do not approve")).toBe(false);
  });

  it("with no question open, approve/reject carries no id (the server refuses to guess between holds)", () => {
    expect(interpret("approve", null)).toEqual({ kind: "decide", decision: "approve" });
    expect(interpret("reject that", null)).toEqual({ kind: "decide", decision: "reject" });
  });

  it("answers to a read-back", () => {
    expect(interpret("yes", draft)).toEqual({ kind: "confirm", mandateId: "man_1" });
    expect(interpret("no, change it", draft)).toEqual({ kind: "keep_draft", mandateId: "man_1" });
  });

  it("other commands, and anything else is a mandate", () => {
    expect(interpret("return it", null).kind).toBe("refund");
    expect(interpret("what happened?", null).kind).toBe("activity");
    expect(interpret("anything waiting?", null).kind).toBe("pending");
    expect(interpret("Find a birthday gift for my sister, around $150", null)).toEqual({
      kind: "mandate",
      text: "Find a birthday gift for my sister, around $150",
    });
  });

  it("“no” keeps the draft, and a later “start now” starts that same draft", () => {
    expect(interpret("no", draft)).toEqual({ kind: "keep_draft", mandateId: "man_1" });
    const kept: Awaiting = { kind: "draft", mandateId: "man_1" };
    for (const t of ["start now", "ok start", "yes, go ahead", "start shopping", "go"]) {
      expect(interpret(t, kept)).toEqual({ kind: "confirm", mandateId: "man_1" });
    }
  });

  it("a bare “start now” with no context asks the server for the only draft; it is never parsed as a mandate", () => {
    expect(interpret("start now", null)).toEqual({ kind: "confirm" });
    expect(interpret("Start", null)).toEqual({ kind: "confirm" });
  });

  it("a real request is still a mandate, even after a kept draft", () => {
    const kept: Awaiting = { kind: "draft", mandateId: "man_1" };
    expect(interpret("Start a weekly grocery budget of $200", kept).kind).toBe("mandate");
    expect(interpret("Go buy a birthday gift for my mom under $80", null).kind).toBe("mandate");
    expect(interpret("Find a book for my dad", kept).kind).toBe("mandate");
  });
});

import { describe as d2, it as i2, expect as e2 } from "vitest";
import { isStop as stop2 } from "./intent";
d2("stop commands with an object", () => {
  i2("reads 'stop all purchases', 'stop the order', 'halt spending money' as stops", () => {
    for (const t of ["stop all purchases", "stop the order", "halt spending money", "freeze my payments"]) e2(stop2(t)).toBe(true);
    for (const t of ["freeze-dried strawberries under $20", "Stop and Shop gift card", "a rubber door stop"]) e2(stop2(t)).toBe(false);
  });
});

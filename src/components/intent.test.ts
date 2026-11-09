import { describe, expect, it } from "vitest";
import { interpret, isApprove, isStop, type Awaiting } from "./intent";

const hold: Awaiting = { kind: "approval", approvalId: "apr_1" };
const draft: Awaiting = { kind: "confirm", mandateId: "man_1" };

describe("command bar intent", () => {
  it("“approve, don't stop” approves the hold and does not freeze", () => {
    expect(interpret("Approve, don't stop", hold)).toEqual({ kind: "decide", decision: "approve", approvalId: "apr_1" });
    expect(interpret("approve it and do not stop shopping", hold).kind).toBe("decide");
  });

  it.each(["stop", "Stop everything", "please stop", "stop it now", "freeze it all", "kill switch", "ok, stop everything"])(
    "“%s” freezes, even while a question is open",
    (t) => {
      expect(interpret(t, null)).toEqual({ kind: "freeze" });
      expect(interpret(t, hold)).toEqual({ kind: "freeze" });
      expect(interpret(t, draft)).toEqual({ kind: "freeze" });
    },
  );

  it.each(["don't stop", "never stop", "A rubber door stop for my office, under $20", "Find a bus stop poster, around $30"])(
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
    expect(interpret("no, change it", draft)).toEqual({ kind: "keep_draft" });
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
});

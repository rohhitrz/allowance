import type { ApprovalDto, PurchaseDto } from "@/server/dto";
import type { EventRow, MandateRow, RunStep } from "@/server/db/schema";
import type { MandateRules, Money, RuleResult } from "@/server/policy/types";

/** What JSON does to a server type: Dates become strings. */
export type J<T> = T extends Date ? string : T extends (infer U)[] ? J<U>[] : T extends object ? { [K in keyof T]: J<T[K]> } : T;

export type Purchase = J<PurchaseDto>;
export type Approval = J<ApprovalDto>;
export type Event = J<EventRow>;
export type Mandate = J<MandateRow> & {
  rules: MandateRules;
  spend: { amount: Money; orders: number; periodStart: string; periodEnd: string | null };
};
export type Receipt = {
  purchase: Purchase;
  mandateSnapshot: { version: number; rules: MandateRules };
  ruleResults: RuleResult[];
  timeline: Event[];
  summary: string;
};
export type Run = { id: string; mandateId: string; status: string; brief: string; model: string; steps: RunStep[]; error: string | null; startedAt: string; endedAt: string | null };
export type { RuleResult, Money };

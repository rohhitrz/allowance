/** The fixed sentence voice reads for a hold. Template, never model text. */
import { fmt } from "../money";
import type { RuleResult } from "../policy/types";

export function approvalPrompt(args: {
  productName: string;
  totalCents: number;
  spentBeforeCents: number;
  budgetCents: number;
  hardLimitCents: number;
  category: string;
  softFailed: RuleResult[];
}): string {
  const reasons: string[] = [];
  for (const r of args.softFailed) {
    if (r.rule === "budget") {
      const over = args.spentBeforeCents + args.totalCents - args.budgetCents;
      reasons.push(`That's ${fmt(over)} over your ${fmt(args.budgetCents)} budget but under your ${fmt(args.hardLimitCents)} limit.`);
    } else if (r.rule === "allowed_category") {
      reasons.push(`It's in ${args.category.replace(/_/g, " ")}, which isn't one of your allowed categories.`);
    }
  }
  return `${args.productName}, ${fmt(args.totalCents)}. ${reasons.join(" ")} Approve or reject?`.replace(/\s+/g, " ");
}

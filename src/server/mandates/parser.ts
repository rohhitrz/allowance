/**
 * Plain language -> MandateDraftInput, using Claude with structured outputs.
 * Claude only drafts. Defaults, validation and the locked blocked categories are
 * applied in code (rules.ts), and a human must confirm before anything is spent.
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { AppError } from "../errors";
import { CATEGORIES } from "../catalog/categories";
import type { MandateDraftInput } from "./rules";

export const PARSER_MODEL = "claude-haiku-5-5";

const ParsedMandate = z.object({
  title: z.string().describe("Short title, e.g. 'Birthday gift for sister'"),
  brief: z.string().describe("One or two sentences telling a shopping agent what to look for"),
  budgetCents: z.number().int().describe("Target budget in US cents ('around $150' -> 15000)"),
  hardLimitCents: z.number().int().nullable().describe("Absolute max in cents ('never more than $200'); null if not stated"),
  perItemMaxCents: z.number().int().nullable().describe("Max price per single item in cents; null if not stated"),
  allowedCategories: z
    .array(z.string())
    .nullable()
    .describe(
      "Every category a suitable item could come from, not just the literal word. A gift for a person: gifts, electronics, books, home. Groceries: groceries, produce, household. Null if anything goes",
    ),
  extraBlockedCategories: z.array(z.string()).describe("Categories the user explicitly excluded"),
  maxOrders: z.number().int().nullable().describe("Number of purchases allowed ('one purchase' -> 1); per period if recurring; null if not stated"),
  maxQuantity: z.number().int().nullable().describe("Max units per order; null if not stated"),
  noDuplicates: z.boolean().nullable().describe("False only if the user wants repeat purchases of the same item"),
  period: z.enum(["once", "weekly", "monthly"]).describe("once for a one-off task; weekly/monthly for a recurring budget"),
  expiresAt: z.string().nullable().describe("ISO 8601 UTC deadline ('by Friday' -> that day 23:59:59 local); null if not stated"),
});

let client: Anthropic | null = null;
const anthropic = () => (client ??= new Anthropic());

export async function parseMandateText(text: string, opts: { now: Date; timezone: string }): Promise<MandateDraftInput> {
  const localNow = opts.now.toLocaleString("en-GB", { timeZone: opts.timezone, dateStyle: "full", timeStyle: "short" });
  const system = [
    "You turn a person's spending instruction for an AI shopping agent into structured rules.",
    "Amounts are US dollars converted to integer cents. Only extract what the person said; use null for anything unstated.",
    `Known categories: ${CATEGORIES.join(", ")}. Map the request to the relevant ones.`,
    `The person's local time is ${localNow} (${opts.timezone}). Resolve relative dates against it and return expiresAt in UTC.`,
  ].join("\n");

  let res;
  try {
    res = await anthropic().messages.parse({
      model: PARSER_MODEL,
      max_tokens: 4000,
      output_config: { effort: "low", format: zodOutputFormat(ParsedMandate) },
      system,
      messages: [{ role: "user", content: text }],
    });
  } catch (e) {
    if (e instanceof Anthropic.APIError) throw new AppError("PARSE_FAILED", `Claude error ${e.status}: ${e.message}`);
    throw e;
  }
  if (res.stop_reason === "refusal" || !res.parsed_output) {
    throw new AppError("PARSE_FAILED", "Couldn't turn that into a mandate", { stopReason: res.stop_reason });
  }
  return res.parsed_output;
}

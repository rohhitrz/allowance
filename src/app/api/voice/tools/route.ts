import { route, json, errorResponse } from "@/server/http/handler";
import { AppError } from "@/server/errors";
import { requireVapi } from "@/server/http/auth";
import { runVoiceTool } from "@/server/voice/tools";

type VapiToolCall = { id: string; name?: string; arguments?: unknown; function?: { name: string; arguments?: unknown } };

/**
 * Vapi server tools. Payload: { message: { type: "tool-calls", toolCallList: [...] } }.
 * Reply: { results: [{ toolCallId, result }] }. Thin adapter: only this file knows Vapi's shape.
 */
export const POST = route(async (req) => {
  const actor = requireVapi(req);
  const payload = (await req.json().catch(() => {
    throw new AppError("VALIDATION_ERROR", "Body is not valid JSON");
  })) as { message?: { type?: string; toolCallList?: unknown; toolCalls?: unknown } } | null;
  const list = payload?.message?.toolCallList ?? payload?.message?.toolCalls ?? [];
  const calls = (Array.isArray(list) ? list : []) as (VapiToolCall | null)[];
  const results = [];
  // Each call stands alone: a malformed one gets an error result, the rest still run.
  for (const c of calls) {
    try {
      const name = c?.name ?? c?.function?.name ?? "";
      let args = c?.arguments ?? c?.function?.arguments ?? {};
      if (typeof args === "string") {
        try {
          args = args ? JSON.parse(args) : {};
        } catch {
          throw new AppError("VALIDATION_ERROR", `Arguments for ${name || "tool"} are not valid JSON`);
        }
      }
      results.push({ toolCallId: c?.id, result: JSON.stringify(await runVoiceTool(name, args, actor)) });
    } catch (e) {
      const err = (await errorResponse(e).json()) as { error: { message: string } };
      results.push({ toolCallId: c?.id, result: JSON.stringify({ error: err.error.message }) });
    }
  }
  return json({ results });
});

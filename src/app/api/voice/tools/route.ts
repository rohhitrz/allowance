import { route, json, errorResponse } from "@/server/http/handler";
import { requireVapi } from "@/server/http/auth";
import { runVoiceTool } from "@/server/voice/tools";

type VapiToolCall = { id: string; name?: string; arguments?: unknown; function?: { name: string; arguments?: unknown } };

/**
 * Vapi server tools. Payload: { message: { type: "tool-calls", toolCallList: [...] } }.
 * Reply: { results: [{ toolCallId, result }] }. Thin adapter: only this file knows Vapi's shape.
 */
export const POST = route(async (req) => {
  const actor = requireVapi(req);
  const payload = (await req.json()) as { message?: { type?: string; toolCallList?: VapiToolCall[]; toolCalls?: VapiToolCall[] } };
  const calls = payload.message?.toolCallList ?? payload.message?.toolCalls ?? [];
  const results = [];
  for (const c of calls) {
    const name = c.name ?? c.function?.name ?? "";
    let args = c.arguments ?? c.function?.arguments ?? {};
    if (typeof args === "string") args = args ? JSON.parse(args) : {};
    try {
      results.push({ toolCallId: c.id, result: JSON.stringify(await runVoiceTool(name, args, actor)) });
    } catch (e) {
      const err = (await errorResponse(e).json()) as { error: { message: string } };
      results.push({ toolCallId: c.id, result: JSON.stringify({ error: err.error.message }) });
    }
  }
  return json({ results });
});

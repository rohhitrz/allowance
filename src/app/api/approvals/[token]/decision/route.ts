import { route, json, body, type Ctx } from "@/server/http/handler";
import { requireUser } from "@/server/http/auth";
import { z } from "zod";
import { decideApproval } from "@/server/transactions/service";
import { getPurchaseDto } from "@/server/app";

/**
 * Human only. The path segment is the approval id (apr_…, used by the dashboard) or the raw
 * single-use token. Anything other than exactly "approve" is a reject.
 */
export const POST = route(async (req, ctx: Ctx<{ token: string }>) => {
  const actor = requireUser(req);
  const { token } = await ctx.params;
  const { decision } = await body(req, z.object({ decision: z.string() }));
  const ref = token.startsWith("apr_") ? { approvalId: token } : { token };
  const out = await decideApproval({ ...ref, decision: decision === "approve" ? "approve" : "reject", actor });
  return json({ approval: out.approval, purchase: await getPurchaseDto(out.purchase.id), alreadyDecided: out.alreadyDecided, note: out.note });
});

import { errorResponse } from "@/server/http/handler";
import { requireMcp } from "@/server/http/auth";
import { clientForKey, handleMcp } from "@/server/mcp/server";

async function handler(req: Request) {
  try {
    requireMcp(req);
    const key = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    return await handleMcp(req, await clientForKey(key));
  } catch (e) {
    return errorResponse(e);
  }
}

export { handler as GET, handler as POST, handler as DELETE };

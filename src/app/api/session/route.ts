import { z } from "zod";
import { route, body } from "@/server/http/handler";
import { checkPasscode, clientAddress, newSessionCookie, recordSignIn, SESSION_COOKIE, signInBlocked } from "@/server/http/auth";
import { AppError } from "@/server/errors";

export const POST = route(async (req) => {
  const addr = clientAddress(req);
  if (signInBlocked(addr)) throw new AppError("RATE_LIMITED", "Too many wrong passcodes. Try again in 15 minutes.");
  const { passcode } = await body(req, z.object({ passcode: z.string().max(200) }));
  const ok = checkPasscode(passcode);
  recordSignIn(addr, ok);
  if (!ok) throw new AppError("UNAUTHORIZED", "Wrong passcode");
  const c = newSessionCookie();
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return new Response(null, {
    status: 204,
    headers: { "Set-Cookie": `${SESSION_COOKIE}=${encodeURIComponent(c.value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${c.maxAge}${secure}` },
  });
});

export const DELETE = route(async () => {
  return new Response(null, { status: 204, headers: { "Set-Cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` } });
});

import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, validSession } from "@/server/http/auth";

/** Optimistic page guard. API routes check auth themselves (cookie, Vapi secret or MCP key). */
export function proxy(req: NextRequest) {
  if (validSession(req.cookies.get(SESSION_COOKIE)?.value)) return NextResponse.next();
  const login = new URL("/login", req.url);
  login.searchParams.set("next", req.nextUrl.pathname);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ["/((?!api|login|_next|favicon.ico|.*\\..*).*)"],
};

/**
 * Auth for the four surfaces (docs/03-api-design.md §1):
 *   dashboard: signed httpOnly cookie, from a single passcode (APP_PASSCODE)
 *   Vapi:      x-vapi-secret header (VAPI_WEBHOOK_SECRET)
 *   MCP:       Authorization: Bearer <MCP_API_KEY>
 * If APP_PASSCODE is unset (local dev), the dashboard is open.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { AppError } from "../errors";

export const SESSION_COOKIE = "allowance_session";
const SESSION_TTL_S = 7 * 24 * 3600;

function secret() {
  return process.env.SESSION_SECRET ?? process.env.APP_PASSCODE ?? "dev-only-secret";
}

function sign(payload: string) {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

export function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export const authRequired = () => Boolean(process.env.APP_PASSCODE);

export function checkPasscode(passcode: string) {
  const want = process.env.APP_PASSCODE;
  return !want || safeEqual(passcode, want);
}

export function newSessionCookie() {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_S;
  const payload = `dashboard.${exp}`;
  return { value: `${payload}.${sign(payload)}`, maxAge: SESSION_TTL_S };
}

export function validSession(value: string | undefined | null): boolean {
  if (!authRequired()) return true;
  if (!value) return false;
  const i = value.lastIndexOf(".");
  if (i < 0) return false;
  const payload = value.slice(0, i);
  if (!safeEqual(value.slice(i + 1), sign(payload))) return false;
  const exp = Number(payload.split(".")[1]);
  return Number.isFinite(exp) && exp * 1000 > Date.now();
}

function cookieFrom(req: Request) {
  const raw = req.headers.get("cookie") ?? "";
  for (const part of raw.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq) === SESSION_COOKIE) return decodeURIComponent(part.slice(eq + 1));
  }
  return null;
}

/** Dashboard user. Returns the actor recorded on every event. */
export function requireUser(req: Request): "user:dashboard" {
  if (!validSession(cookieFrom(req))) throw new AppError("UNAUTHORIZED", "Sign in first");
  return "user:dashboard";
}

export function requireVapi(req: Request): "user:voice" {
  const want = process.env.VAPI_WEBHOOK_SECRET;
  const got = req.headers.get("x-vapi-secret") ?? "";
  if (!want || !safeEqual(got, want)) throw new AppError("UNAUTHORIZED", "Bad x-vapi-secret");
  return "user:voice";
}

/** MCP client. One shared key for the demo; the client name comes from the MCP handshake. */
export function requireMcp(req: Request) {
  const want = process.env.MCP_API_KEY;
  const got = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!want || !safeEqual(got, want)) throw new AppError("UNAUTHORIZED", "Bad or missing MCP bearer key");
}

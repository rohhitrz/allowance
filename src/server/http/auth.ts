/**
 * Auth for the four surfaces (docs/03-api-design.md §1):
 *   dashboard: signed httpOnly cookie, from a single passcode (APP_PASSCODE)
 *   Vapi:      x-vapi-secret header (VAPI_WEBHOOK_SECRET)
 *   MCP:       Authorization: Bearer <MCP_API_KEY>
 * If APP_PASSCODE is unset, the dashboard is open in local dev and LOCKED in production:
 * a deployed app with no passcode lets nobody in, rather than everybody.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { AppError } from "../errors";

export const SESSION_COOKIE = "allowance_session";
const SESSION_TTL_S = 7 * 24 * 3600;

/**
 * In production, cookies are signed only with SESSION_SECRET (render.yaml generates one). Signing
 * with the passcode would let anyone holding one cookie brute-force the passcode offline, so a
 * production server with no SESSION_SECRET stays locked rather than falling back.
 */
function secret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (isProduction()) throw new AppError("UNAUTHORIZED", "Dashboard is locked: set SESSION_SECRET on the server");
  return process.env.APP_PASSCODE ?? "dev-only-secret";
}

function sign(payload: string) {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

export function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const isProduction = () => process.env.NODE_ENV === "production";

/** "passcode": sign in with APP_PASSCODE. "open": local dev, no passcode. "locked": production with no passcode set. */
export function authMode(): "passcode" | "open" | "locked" {
  if (process.env.APP_PASSCODE) return isProduction() && !process.env.SESSION_SECRET ? "locked" : "passcode";
  return isProduction() ? "locked" : "open";
}

export const authRequired = () => authMode() !== "open";

// ---------- sign-in throttling ----------
// In memory, per client address: enough for one instance. 10 wrong passcodes in 15 minutes
// blocks that address until the window passes.
const FAILS_ALLOWED = 10;
const FAIL_WINDOW_MS = 15 * 60_000;
const fails = new Map<string, { n: number; since: number }>();

export function clientAddress(req: Request) {
  return (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || req.headers.get("x-real-ip") || "local";
}

export function signInBlocked(addr: string, now = Date.now()) {
  const f = fails.get(addr);
  if (!f || now - f.since > FAIL_WINDOW_MS) return false;
  return f.n >= FAILS_ALLOWED;
}

export function recordSignIn(addr: string, ok: boolean, now = Date.now()) {
  if (ok) return void fails.delete(addr);
  const f = fails.get(addr);
  if (!f || now - f.since > FAIL_WINDOW_MS) fails.set(addr, { n: 1, since: now });
  else f.n++;
  if (fails.size > 10_000) for (const [k, v] of fails) if (now - v.since > FAIL_WINDOW_MS) fails.delete(k);
}

/** Tests only. */
export const clearSignInFailures = () => fails.clear();

export function checkPasscode(passcode: string) {
  const want = process.env.APP_PASSCODE;
  if (!want) return authMode() === "open";
  if (authMode() === "locked") return false; // production without SESSION_SECRET: nobody gets in
  return safeEqual(passcode, want);
}

export function newSessionCookie() {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_S;
  const payload = `dashboard.${exp}`;
  return { value: `${payload}.${sign(payload)}`, maxAge: SESSION_TTL_S };
}

export function validSession(value: string | undefined | null): boolean {
  const mode = authMode();
  if (mode === "open") return true;
  if (mode === "locked" || !value) return false;
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
  if (authMode() === "locked") throw new AppError("UNAUTHORIZED", "Dashboard is locked: set APP_PASSCODE on the server");
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

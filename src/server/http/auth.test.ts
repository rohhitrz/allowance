import { afterEach, describe, expect, it, vi } from "vitest";
import { checkPasscode, newSessionCookie, requireMcp, requireUser, requireVapi, SESSION_COOKIE, validSession } from "./auth";

const req = (headers: Record<string, string>) => new Request("http://x/api", { headers });

describe("auth", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("dashboard is open when no passcode is set (local dev)", () => {
    vi.stubEnv("APP_PASSCODE", "");
    expect(requireUser(req({}))).toBe("user:dashboard");
  });

  it("signed session cookie: valid, tampered, expired", () => {
    vi.stubEnv("APP_PASSCODE", "hunter2");
    expect(checkPasscode("hunter2")).toBe(true);
    expect(checkPasscode("nope")).toBe(false);
    const c = newSessionCookie();
    expect(validSession(c.value)).toBe(true);
    expect(requireUser(req({ cookie: `${SESSION_COOKIE}=${encodeURIComponent(c.value)}` }))).toBe("user:dashboard");
    expect(validSession(c.value.replace("dashboard.", "dashboard.9"))).toBe(false);
    expect(validSession(undefined)).toBe(false);
    expect(() => requireUser(req({}))).toThrow(/Sign in/);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 8 * 24 * 3600_000);
    expect(validSession(c.value)).toBe(false);
    vi.useRealTimers();
  });

  it("Vapi and MCP need their secrets, and fail closed when unset", () => {
    vi.stubEnv("VAPI_WEBHOOK_SECRET", "");
    vi.stubEnv("MCP_API_KEY", "");
    expect(() => requireVapi(req({ "x-vapi-secret": "" }))).toThrow();
    expect(() => requireMcp(req({ authorization: "Bearer " }))).toThrow();
    vi.stubEnv("VAPI_WEBHOOK_SECRET", "s3");
    vi.stubEnv("MCP_API_KEY", "k3");
    expect(requireVapi(req({ "x-vapi-secret": "s3" }))).toBe("user:voice");
    expect(() => requireMcp(req({ authorization: "Bearer k3" }))).not.toThrow();
    expect(() => requireMcp(req({ authorization: "Bearer k4" }))).toThrow();
  });
});

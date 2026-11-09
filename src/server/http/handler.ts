/** Route handler plumbing: one error shape, zod validation, JSON out. */
import { z } from "zod";
import { AppError } from "../errors";

export type Ctx<P = Record<string, string>> = { params: Promise<P> };

export function errorResponse(e: unknown): Response {
  if (e instanceof AppError) {
    return Response.json({ error: { code: e.code, message: e.message, details: e.details } }, { status: e.status });
  }
  if (e instanceof z.ZodError) {
    return Response.json(
      { error: { code: "VALIDATION_ERROR", message: "Invalid request body", details: { issues: e.issues } } },
      { status: 400 },
    );
  }
  console.error("[api] unexpected error", e);
  const message = e instanceof Error ? e.message : String(e);
  return Response.json({ error: { code: "INTERNAL", message, details: {} } }, { status: 500 });
}

/** Wrap a handler so thrown AppErrors / zod errors become the documented error shape. */
export function route<P>(fn: (req: Request, ctx: Ctx<P>) => Promise<Response>) {
  return async (req: Request, ctx: Ctx<P>) => {
    try {
      return await fn(req, ctx);
    } catch (e) {
      return errorResponse(e);
    }
  };
}

export async function body<T extends z.ZodType>(req: Request, schema: T): Promise<z.infer<T>> {
  let raw: unknown = {};
  const text = await req.text();
  if (text) {
    try {
      raw = JSON.parse(text);
    } catch {
      throw new AppError("VALIDATION_ERROR", "Body is not valid JSON");
    }
  }
  return schema.parse(raw);
}

/** A whole-number query parameter, or undefined if absent. Anything else is a 400, never a 500. */
export function intParam(raw: string | null, name: string, range: { min?: number; max?: number } = {}): number | undefined {
  if (raw === null || raw === "") return undefined;
  const n = Number(raw);
  const { min = 0, max = Number.MAX_SAFE_INTEGER } = range;
  if (!/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(n) || n < min || n > max) {
    throw new AppError("VALIDATION_ERROR", `${name} must be a whole number from ${min} to ${max}`);
  }
  return n;
}

export const json = (data: unknown, status = 200) => Response.json(data, { status });

export function demoOnly() {
  if (process.env.DEMO_MODE !== "true") throw new AppError("NOT_FOUND", "Demo mode is off");
}

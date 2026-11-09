import { route, json, body } from "@/server/http/handler";
import { requireUser } from "@/server/http/auth";
import { z } from "zod";
import { draftMandateFromText, listMandates } from "@/server/mandates/service";

const STATUS = z.enum(["DRAFT", "ACTIVE", "FROZEN", "EXPIRED", "CANCELLED"]).optional();

export const GET = route(async (req) => {
  requireUser(req);
  const status = STATUS.parse(new URL(req.url).searchParams.get("status") ?? undefined);
  return json({ mandates: await listMandates({ status }) });
});

export const POST = route(async (req) => {
  const actor = requireUser(req);
  const { text } = await body(req, z.object({ text: z.string().trim().min(3).max(2000) }));
  return json(await draftMandateFromText({ text, actor }), 201);
});

import { route, json } from "@/server/http/handler";
import { requireUser } from "@/server/http/auth";
import { z } from "zod";
import { listApprovals } from "@/server/app";

const STATUS = z.enum(["PENDING", "APPROVED", "REJECTED", "EXPIRED", "CANCELLED"]).optional();

export const GET = route(async (req) => {
  requireUser(req);
  return json({ approvals: await listApprovals(STATUS.parse(new URL(req.url).searchParams.get("status") ?? undefined)) });
});

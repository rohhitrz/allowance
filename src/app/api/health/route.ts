import { route, json } from "@/server/http/handler";
import { dbUp } from "@/server/app";
import { authMode } from "@/server/http/auth";

export const GET = route(async () => {
  const up = await dbUp();
  return json(
    { ok: up, db: up ? "up" : "down", paypal: process.env.PAYPAL_CLIENT_ID ? "configured" : "missing", claude: process.env.ANTHROPIC_API_KEY ? "configured" : "missing", demoMode: process.env.DEMO_MODE === "true", auth: authMode() },
    up ? 200 : 503,
  );
});

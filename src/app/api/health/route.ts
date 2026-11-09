import { route, json } from "@/server/http/handler";
import { dbUp } from "@/server/app";

export const GET = route(async () => {
  const up = await dbUp();
  return json(
    { ok: up, db: up ? "up" : "down", paypal: process.env.PAYPAL_CLIENT_ID ? "configured" : "missing", claude: process.env.ANTHROPIC_API_KEY ? "configured" : "missing", demoMode: process.env.DEMO_MODE === "true" },
    up ? 200 : 503,
  );
});

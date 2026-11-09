/**
 * The app's public URL, for links PayPal sends the buyer back to and for MCP results.
 * APP_BASE_URL wins; on Render, RENDER_EXTERNAL_URL is set automatically. Behind Render's
 * proxy the request's own origin is an internal address, so it's only the last resort.
 */
export function appBaseUrl(fallback = "http://localhost:3000"): string {
  return process.env.APP_BASE_URL || process.env.RENDER_EXTERNAL_URL || fallback;
}

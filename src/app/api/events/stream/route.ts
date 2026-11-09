import { route } from "@/server/http/handler";
import { requireUser } from "@/server/http/auth";
import { bus } from "@/server/events/bus";
import { listEvents } from "@/server/app";
import type { EventRow } from "@/server/db/schema";

/**
 * SSE: `id: <event id>`, `event: <type>`, `data: Event`. Heartbeat every 15 s.
 * Reconnects send Last-Event-ID (or ?since=) and get what they missed from the DB first.
 */
export const GET = route(async (req) => {
  requireUser(req);
  const sinceRaw = req.headers.get("last-event-id") ?? new URL(req.url).searchParams.get("since");
  const since = sinceRaw ? Number(sinceRaw) : undefined;
  const enc = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // Dedupe only across the replay/live seam. After that, send everything: a demo reset
      // restarts event ids, and an id filter would silence the stream.
      const replayed = new Set<number>();
      const send = (chunk: string) => {
        try {
          controller.enqueue(enc.encode(chunk));
        } catch {
          cleanup();
        }
      };
      const sendEvent = (e: EventRow) => send(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
      // Buffer live events while the replay query runs, so nothing falls in the gap.
      const buffered: EventRow[] = [];
      let replaying = true;
      const onEvent = (e: EventRow) => (replaying ? buffered.push(e) : sendEvent(e));
      bus.on("event", onEvent);
      const heartbeat = setInterval(() => send(`: ping\n\n`), 15_000);
      cleanup = () => {
        clearInterval(heartbeat);
        bus.off("event", onEvent);
      };
      req.signal.addEventListener("abort", () => {
        cleanup();
        try {
          controller.close();
        } catch {}
      });

      send(`retry: 2000\n\n`);
      if (since !== undefined) {
        for (const e of await listEvents({ since, limit: 500 })) {
          replayed.add(e.id);
          sendEvent(e);
        }
      }
      replaying = false;
      for (const e of buffered) if (!replayed.has(e.id)) sendEvent(e);
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
});

/** Runs once per server start. The 60-second sweep expires stale holds and mandates. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const g = globalThis as unknown as { __allowanceSweep?: NodeJS.Timeout };
  if (g.__allowanceSweep) return;
  const { sweepExpiredApprovals } = await import("./server/transactions/service");
  const { expireMandates } = await import("./server/mandates/service");
  const { recoverStaleRuns } = await import("./server/agent/runner");
  let running = false;
  g.__allowanceSweep = setInterval(() => {
    if (running) return; // a slow PayPal must not stack sweeps on top of each other
    running = true;
    Promise.all([sweepExpiredApprovals(), expireMandates(), recoverStaleRuns()])
      .catch((e) => console.error("[sweep]", e))
      .finally(() => (running = false));
  }, 60_000);
}

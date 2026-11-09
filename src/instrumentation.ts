/** Runs once per server start. The 60-second sweep expires stale holds and mandates. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const g = globalThis as unknown as { __allowanceSweep?: NodeJS.Timeout };
  if (g.__allowanceSweep) return;
  const { sweepExpiredApprovals } = await import("./server/transactions/service");
  const { expireMandates } = await import("./server/mandates/service");
  g.__allowanceSweep = setInterval(() => {
    Promise.all([sweepExpiredApprovals(), expireMandates()]).catch((e) => console.error("[sweep]", e));
  }, 60_000);
}

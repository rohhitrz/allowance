/**
 * Live events reach every open dashboard tab, and a reconnect can replay one. Without this,
 * each tab speaks the same announcement and the user hears it twice (or more). One tab claims
 * each event id; the claim is atomic across tabs (Web Locks) and remembered (localStorage).
 * Hidden tabs never speak announcements: the tab you're looking at does.
 */
const KEY = "allowance:spoken";

function claimed(): number[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "[]") as number[];
  } catch {
    return [];
  }
}

function tryClaim(eventId: number): boolean {
  const seen = claimed();
  if (seen.includes(eventId)) return false;
  try {
    localStorage.setItem(KEY, JSON.stringify([...seen.slice(-199), eventId]));
  } catch {
    /* storage blocked: the lock below still stops two tabs at the same moment */
  }
  return true;
}

export function speakOnce(eventId: number, speak: () => void) {
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  if (!locks) {
    if (tryClaim(eventId)) speak();
    return;
  }
  void locks.request("allowance-speak", async () => {
    if (tryClaim(eventId)) speak();
  });
}

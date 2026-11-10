import { afterEach, describe, expect, it, vi } from "vitest";
import { speakOnce } from "./speakOnce";

function fakeBrowser(visible = true) {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
  vi.stubGlobal("document", { visibilityState: visible ? "visible" : "hidden" });
  // Web Locks: run callbacks one at a time, like the browser does across tabs.
  let chain = Promise.resolve();
  vi.stubGlobal("navigator", { locks: { request: (_: string, cb: () => Promise<void>) => (chain = chain.then(cb)) } });
  return () => chain;
}

describe("speakOnce", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("the same event delivered twice (two tabs, or a replay after reconnect) is spoken once", async () => {
    const settle = fakeBrowser();
    const speak = vi.fn();
    speakOnce(42, speak);
    speakOnce(42, speak);
    speakOnce(43, speak);
    await settle();
    expect(speak).toHaveBeenCalledTimes(2);
  });

  it("a hidden tab never speaks announcements", async () => {
    const settle = fakeBrowser(false);
    const speak = vi.fn();
    speakOnce(7, speak);
    await settle();
    expect(speak).not.toHaveBeenCalled();
  });
});

import type { Money } from "./policy/types";

export const usd = (amountCents: number): Money => ({ amountCents, currency: "USD" });

/** 15000 -> "$150.00" */
export function fmt(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100).toLocaleString("en-US")}.${String(abs % 100).padStart(2, "0")}`;
}

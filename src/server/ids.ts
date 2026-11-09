import { createHash, randomBytes } from "node:crypto";

const ALPHABET = "0123456789abcdefghijkmnpqrstuvwxyz";

/** Prefixed random id, e.g. id("pur") -> "pur_k3x9q2m7ab4c". */
export function id(prefix: "man" | "pur" | "apr" | "prd" | "run" | "usr" | "cli" | "vlt"): string {
  const bytes = randomBytes(12);
  let s = "";
  for (const b of bytes) s += ALPHABET[b % ALPHABET.length];
  return `${prefix}_${s}`;
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export const newToken = () => randomBytes(24).toString("base64url");

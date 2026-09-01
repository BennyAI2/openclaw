import { stableStringify } from "@openclaw/normalization-core";
import { sha256Hex } from "../infra/crypto-digest.js";

export function digestClawCanonicalValue(value: unknown): string {
  return `sha256:${sha256Hex(stableStringify(value))}`;
}

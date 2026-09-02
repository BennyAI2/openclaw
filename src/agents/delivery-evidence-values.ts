import { hasNonEmptyString } from "@openclaw/normalization-core/string-coerce";

export function hasNonEmptyStringArray(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.some(hasNonEmptyString);
}

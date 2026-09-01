import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";

export function quotePosixShellArgument(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

export function formatSystemOwnershipFailureDetail(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return truncateUtf16Safe(sanitizeForLog(raw), 500);
}

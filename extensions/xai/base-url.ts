import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { XAI_BASE_URL } from "./model-definitions.js";

export function resolveXaiBaseUrl(value?: string): string {
  // Select explicit input before trimming so blank input suppresses the environment override.
  return normalizeOptionalString(value ?? process.env.XAI_BASE_URL) ?? XAI_BASE_URL;
}

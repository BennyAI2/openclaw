// CLI-facing TCP port parser and validator wrappers.
import { parseTcpPort } from "../../infra/tcp-port.js";
import { formatPortRangeHint } from "../error-format.js";

/** Parse a TCP port from unknown CLI/config input, returning null for invalid values. */
export function parsePort(raw: unknown): number | null {
  return parseTcpPort(raw);
}

export function validateGatewayPortInput(value: unknown): string | undefined {
  if (parsePort(value) === null) {
    return formatPortRangeHint();
  }
  return undefined;
}

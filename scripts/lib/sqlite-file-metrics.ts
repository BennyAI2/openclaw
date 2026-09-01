import { statSync } from "node:fs";

export function readSqliteMetricBytes(pathname: string): number {
  try {
    return statSync(pathname).size;
  } catch {
    // Metric sampling is best-effort; any stat failure counts as zero.
    return 0;
  }
}

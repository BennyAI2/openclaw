/** Creates sanitized OpenClaw GitHub issues through the installed GitHub CLI. */
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { truncateUtf8Prefix } from "../utils/utf8-truncate.js";

export type SanitizedGithubIssue = {
  body: string;
  title: string;
  url: string;
};

export type GithubIssueCreateResult =
  | { ok: true; url: string }
  | { fallbackUrl: string; message: string; ok: false };

type SpawnGh = (
  args: readonly string[],
  options: { input: string },
) => Pick<SpawnSyncReturns<Buffer>, "error" | "status" | "stderr" | "stdout">;

const GITHUB_ISSUE_CREATE_TIMEOUT_MS = 30_000;
const GITHUB_PREFILL_BODY_MAX_BYTES = 6_000;
const REPOSITORY_ISSUES_URL = "https://github.com/openclaw/openclaw/issues";

/** Builds the browser handoff used when the authenticated GitHub CLI is unavailable. */
export function createPrefilledGithubIssueUrl(title: string, body: string): string {
  const truncated = Buffer.byteLength(body, "utf8") > GITHUB_PREFILL_BODY_MAX_BYTES;
  const urlBody = truncated
    ? `${truncateUtf8Prefix(body, GITHUB_PREFILL_BODY_MAX_BYTES)}\n\n...(truncated for URL; see the saved sanitized report for the complete body)`
    : body;
  const params = new URLSearchParams({ body: urlBody, title });
  return `https://github.com/openclaw/openclaw/issues/new?${params.toString()}`;
}

/** Creates an openclaw/openclaw issue through the GitHub CLI using sanitized stdin. */
export function createGithubIssue(
  issue: SanitizedGithubIssue,
  spawnGh: SpawnGh = defaultSpawnGh,
): GithubIssueCreateResult {
  const result = spawnGh(
    ["issue", "create", "--repo", "openclaw/openclaw", "--title", issue.title, "--body-file", "-"],
    { input: issue.body },
  );
  if (!result.error && result.status === 0) {
    const outputUrl = String(result.stdout).trim().split(/\r?\n/).at(-1);
    let url = REPOSITORY_ISSUES_URL;
    try {
      const parsed = new URL(outputUrl ?? "");
      if (
        parsed.protocol === "https:" &&
        parsed.hostname === "github.com" &&
        /^\/openclaw\/openclaw\/issues\/\d+$/u.test(parsed.pathname)
      ) {
        url = parsed.toString();
      }
    } catch {
      // A successful gh exit without its normal issue URL still means the issue was created.
    }
    return { ok: true, url };
  }
  const stderr = String(result.stderr).trim();
  const error = result.error
    ? result.error.message
    : stderr || `gh exited ${result.status ?? "unknown"}`;
  return {
    fallbackUrl: issue.url,
    message: error,
    ok: false,
  };
}

function defaultSpawnGh(
  args: readonly string[],
  options: { input: string },
): Pick<SpawnSyncReturns<Buffer>, "error" | "status" | "stderr" | "stdout"> {
  if (process.env.VITEST || process.env.NODE_ENV === "test") {
    return {
      error: Object.assign(
        new Error("External GitHub issue creation is disabled in test processes."),
        { code: "EPERM" },
      ),
      status: null,
      stderr: Buffer.alloc(0),
      stdout: Buffer.alloc(0),
    };
  }
  return spawnSync("gh", [...args], {
    input: options.input,
    killSignal: "SIGKILL",
    maxBuffer: 1024 * 1024,
    timeout: GITHUB_ISSUE_CREATE_TIMEOUT_MS,
  });
}

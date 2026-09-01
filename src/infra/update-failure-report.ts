/** Privacy-bounded, consent-gated reporting for one terminal update failure. */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { redactSupportString } from "../logging/diagnostic-support-redaction.js";
import { classifyUpdateOutcome } from "../shared/update-outcome.js";
import { truncateUtf8Prefix } from "../utils/utf8-truncate.js";
import { VERSION } from "../version.js";
import {
  createGithubIssue,
  createPrefilledGithubIssueUrl,
  type GithubIssueCreateResult,
  type SanitizedGithubIssue,
} from "./github-issue.js";
import type { UpdateRunResult } from "./update-runner.js";

const UPDATE_REPORT_BODY_MAX_BYTES = 16_000;
const UPDATE_REPORT_FIELD_MAX_BYTES = 512;
const UPDATE_REPORT_DIAGNOSTIC_MAX_BYTES = 1_024;

export type PreparedUpdateFailureReport = SanitizedGithubIssue & {
  attemptId: string;
  previewDigest: string;
  savedReportPath: string;
};

export type UpdateFailureReportSubmitResult =
  | { savedReportPath: string; status: "created"; url: string }
  | {
      fallbackUrl: string;
      message: string;
      savedReportPath: string;
      status: "fallback";
    }
  | {
      fallbackUrl?: string;
      message: string;
      savedReportPath: string;
      status: "duplicate";
      url?: string;
    };

export type UpdateFailureReportInput = {
  attemptId: string;
  error?: string;
  result: UpdateRunResult;
  target?: string;
};

type UpdateFailureReportContext = {
  env: NodeJS.ProcessEnv;
  stateDir: string;
};

type UpdateFailureReportReceipt = {
  fallbackUrl?: string;
  savedReportPath: string;
  status: "pending" | "created" | "fallback";
  url?: string;
};

function stripPrivatePaths(value: string): string {
  return value
    .replace(/(^|[\s("'`])\/(?:[^\s"'`<>]|\/(?!\/))+/gmu, "$1[redacted-path]")
    .replace(/\\\\[^\s"'`<>]+/gu, "[redacted-path]")
    .replace(/\b[A-Za-z]:\\[^\s"'`<>]+/gu, "[redacted-path]");
}

function stripExecutableRecoveryCommands(value: string): string {
  return value.replace(
    /\b(?:openclaw|pnpm|npm|bun|git|yarn|node|npx|deno|curl|wget|bash|sh|zsh|powershell|pwsh|cmd|brew|apt|apt-get|dnf|yum|docker|systemctl|launchctl)\s+[^\r\n]*/giu,
    "[redacted-command]",
  );
}

function sanitizeReportField(
  value: unknown,
  context: UpdateFailureReportContext,
  maxBytes = UPDATE_REPORT_FIELD_MAX_BYTES,
): string {
  const text =
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
      ? String(value)
      : "unknown";
  const redacted = redactSupportString(text, {
    env: context.env,
    stateDir: context.stateDir,
  });
  return truncateUtf8Prefix(
    stripExecutableRecoveryCommands(stripPrivatePaths(redacted)).trim(),
    maxBytes,
  );
}

function resolveFailedSteps(result: UpdateRunResult) {
  return result.steps.filter(
    (step) =>
      !step.advisory &&
      (step.exitCode !== 0 || step.killed === true || step.termination === "timeout"),
  );
}

function resolveFailedPhase(result: UpdateRunResult, context: UpdateFailureReportContext): string {
  const failed = resolveFailedSteps(result).at(-1);
  return sanitizeReportField(failed?.name ?? result.reason ?? "unknown", context);
}

function resolveUpdateTarget(
  input: UpdateFailureReportInput,
  context: UpdateFailureReportContext,
): string {
  const explicit = input.target?.trim();
  if (explicit) {
    return sanitizeReportField(explicit, context);
  }
  const afterVersion = input.result.after?.version?.trim();
  if (afterVersion) {
    return sanitizeReportField(`version ${afterVersion}`, context);
  }
  const afterSha = input.result.after?.sha?.trim();
  if (afterSha) {
    return sanitizeReportField(`commit ${afterSha}`, context);
  }
  return sanitizeReportField(`${input.result.mode} update (exact target unavailable)`, context);
}

function resolveRollbackOutcome(
  result: UpdateRunResult,
  context: UpdateFailureReportContext,
): string {
  if (result.recovery?.serviceRestartSafe === true) {
    return "verified safe to restart";
  }
  if (result.recovery?.serviceRestartSafe === false) {
    return sanitizeReportField(`not verified (${result.recovery.reason})`, context);
  }
  return "not recorded";
}

function renderBoundedDiagnostics(
  input: UpdateFailureReportInput,
  context: UpdateFailureReportContext,
): string[] {
  const diagnostics = [
    `Result: ${input.result.status}`,
    `Update mode: ${sanitizeReportField(input.result.mode, context)}`,
    `Reason code: ${sanitizeReportField(input.result.reason ?? "unknown", context)}`,
  ];
  for (const step of resolveFailedSteps(input.result).slice(-3)) {
    const phase = sanitizeReportField(step.name, context);
    const termination = step.termination ? `, termination ${step.termination}` : "";
    diagnostics.push(`Failed phase ${phase}: exit ${step.exitCode ?? "unknown"}${termination}`);
  }
  if (input.error?.trim()) {
    diagnostics.push(
      `Error summary: ${sanitizeReportField(
        input.error,
        context,
        UPDATE_REPORT_DIAGNOSTIC_MAX_BYTES,
      )}`,
    );
  }
  return diagnostics;
}

function resolveReportPaths(
  attemptId: string,
  stateDir: string,
): {
  reportDir: string;
  reportPath: string;
  receiptPath: string;
} {
  const key = createHash("sha256").update(attemptId).digest("hex");
  const reportDir = path.join(stateDir, "update-reports");
  return {
    reportDir,
    reportPath: path.join(reportDir, `${key}.md`),
    receiptPath: path.join(reportDir, `${key}.receipt.json`),
  };
}

/** Prepares and saves the exact sanitized body the user must review before submission. */
export async function prepareUpdateFailureReport(
  input: UpdateFailureReportInput,
  options: { env?: NodeJS.ProcessEnv; stateDir?: string } = {},
): Promise<PreparedUpdateFailureReport> {
  if (!input.attemptId.trim()) {
    throw new Error("Update report attempt identity is required.");
  }
  if (classifyUpdateOutcome(input.result) !== "failed") {
    throw new Error("Only a final failed update can be reported.");
  }
  const env = options.env ?? process.env;
  const stateDir = options.stateDir ?? resolveStateDir(env);
  const context = { env, stateDir };
  const version = sanitizeReportField(VERSION, context);
  const platform = sanitizeReportField(`${process.platform}/${process.arch}`, context);
  const target = resolveUpdateTarget(input, context);
  const phase = resolveFailedPhase(input.result, context);
  const rollback = resolveRollbackOutcome(input.result, context);
  const body = truncateUtf8Prefix(
    [
      "# OpenClaw update failure report",
      "",
      "This report was explicitly reviewed and confirmed in OpenClaw.",
      "",
      `- OpenClaw version: ${version}`,
      `- Platform: ${platform}`,
      `- Update target: ${target}`,
      `- Failed phase: ${phase}`,
      `- Rollback outcome: ${rollback}`,
      "",
      "## Bounded diagnostics",
      "",
      ...renderBoundedDiagnostics(input, context).map((line) => `- ${line}`),
      "",
    ].join("\n"),
    UPDATE_REPORT_BODY_MAX_BYTES,
  );
  const title = sanitizeReportField(`Update failure: ${phase} (${version})`, context, 200).replace(
    /\s+/gu,
    " ",
  );
  const url = createPrefilledGithubIssueUrl(title, body);
  const { reportDir, reportPath } = resolveReportPaths(input.attemptId, stateDir);
  await fs.mkdir(reportDir, { mode: 0o700, recursive: true });
  await fs.writeFile(reportPath, body, { encoding: "utf8", mode: 0o600 });
  await fs.chmod(reportPath, 0o600);
  return {
    attemptId: input.attemptId,
    body,
    previewDigest: createHash("sha256").update(body).digest("hex"),
    savedReportPath: reportPath,
    title,
    url,
  };
}

async function readExistingReceipt(
  receiptPath: string,
  savedReportPath: string,
): Promise<UpdateFailureReportSubmitResult> {
  try {
    // SAFETY: the receipt is written only by this module and every optional field is rechecked.
    const parsed = JSON.parse(await fs.readFile(receiptPath, "utf8")) as UpdateFailureReportReceipt;
    return {
      status: "duplicate",
      savedReportPath: parsed.savedReportPath || savedReportPath,
      ...(parsed.url ? { url: parsed.url } : {}),
      ...(parsed.fallbackUrl ? { fallbackUrl: parsed.fallbackUrl } : {}),
      message:
        parsed.status === "pending"
          ? "This update attempt already has a report submission in progress."
          : "This update attempt was already reported.",
    };
  } catch {
    return {
      status: "duplicate",
      savedReportPath,
      message: "This update attempt already has a report reservation.",
    };
  }
}

async function writeReceipt(
  receiptPath: string,
  receipt: UpdateFailureReportReceipt,
): Promise<void> {
  const tempPath = `${receiptPath}.${process.pid}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(receipt)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(tempPath, receiptPath);
  await fs.chmod(receiptPath, 0o600);
}

/** Consumes one reviewed preview and invokes the shared GitHub issue creator at most once. */
export async function submitUpdateFailureReport(
  prepared: PreparedUpdateFailureReport,
  previewDigest: string,
  options: {
    createIssue?: (issue: SanitizedGithubIssue) => GithubIssueCreateResult;
    env?: NodeJS.ProcessEnv;
    stateDir?: string;
  } = {},
): Promise<UpdateFailureReportSubmitResult> {
  if (previewDigest !== prepared.previewDigest) {
    throw new Error("The update report preview is stale. Review it again before submitting.");
  }
  const env = options.env ?? process.env;
  const stateDir = options.stateDir ?? resolveStateDir(env);
  const context = { env, stateDir };
  const { reportDir, receiptPath } = resolveReportPaths(prepared.attemptId, stateDir);
  await fs.mkdir(reportDir, { mode: 0o700, recursive: true });
  try {
    const reservation = await fs.open(receiptPath, "wx", 0o600);
    await reservation.writeFile(
      `${JSON.stringify({
        savedReportPath: prepared.savedReportPath,
        status: "pending",
      } satisfies UpdateFailureReportReceipt)}\n`,
      "utf8",
    );
    await reservation.close();
  } catch (error) {
    // SAFETY: Node filesystem errors expose `code`; unknown errors safely miss this comparison.
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return await readExistingReceipt(receiptPath, prepared.savedReportPath);
    }
    throw error;
  }

  const created = (options.createIssue ?? createGithubIssue)(prepared);
  if (created.ok) {
    await writeReceipt(receiptPath, {
      savedReportPath: prepared.savedReportPath,
      status: "created",
      url: created.url,
    });
    return { savedReportPath: prepared.savedReportPath, status: "created", url: created.url };
  }
  const message = sanitizeReportField(created.message, context);
  await writeReceipt(receiptPath, {
    fallbackUrl: created.fallbackUrl,
    savedReportPath: prepared.savedReportPath,
    status: "fallback",
  });
  return {
    fallbackUrl: created.fallbackUrl,
    message,
    savedReportPath: prepared.savedReportPath,
    status: "fallback",
  };
}

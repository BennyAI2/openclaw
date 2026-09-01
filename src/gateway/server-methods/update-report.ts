/** Consent-gated Gateway owner for one sanitized failed-update report. */
import {
  validateUpdateReportParams,
  validateUpdateReportResult,
} from "../../../packages/gateway-protocol/src/index.js";
import type { RestartSentinelPayload } from "../../infra/restart-sentinel.js";
import {
  prepareUpdateFailureReport,
  submitUpdateFailureReport,
  type UpdateFailureReportInput,
} from "../../infra/update-failure-report.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { classifyUpdateOutcome } from "../../shared/update-outcome.js";
import {
  getLatestUpdateRestartSentinel,
  refreshLatestUpdateRestartSentinel,
} from "../server-restart-sentinel.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

type RecoveryFailureReason = Exclude<
  NonNullable<UpdateRunResult["recovery"]>,
  { serviceRestartSafe: true }
>["reason"];

const RECOVERY_FAILURE_REASONS: ReadonlySet<string> = new Set([
  "source-rollback-failed",
  "manager-unavailable",
  "deps-install-failed",
  "build-failed",
  "rollback-checkout-dirty",
  "runtime-verification-failed",
]);

function isRecoveryFailureReason(value: string): value is RecoveryFailureReason {
  return RECOVERY_FAILURE_REASONS.has(value);
}

function readIdentity(value: Record<string, unknown> | null | undefined) {
  return value
    ? {
        ...(typeof value.sha === "string" ? { sha: value.sha } : {}),
        ...(typeof value.version === "string" ? { version: value.version } : {}),
        ...(typeof value.buildId === "string" ? { buildId: value.buildId } : {}),
        ...(typeof value.upstreamRef === "string" ? { upstreamRef: value.upstreamRef } : {}),
      }
    : undefined;
}

function projectReportInput(payload: RestartSentinelPayload): UpdateFailureReportInput | null {
  if (
    payload.kind !== "update" ||
    classifyUpdateOutcome({
      status: payload.status,
      reason: payload.stats?.reason ?? undefined,
    }) !== "failed" ||
    !payload.stats
  ) {
    return null;
  }
  const stats = payload.stats;
  const mode =
    stats.mode === "git" || stats.mode === "pnpm" || stats.mode === "bun" || stats.mode === "npm"
      ? stats.mode
      : "unknown";
  const recovery =
    stats.recovery?.serviceRestartSafe === true
      ? ({ serviceRestartSafe: true } as const)
      : stats.recovery?.serviceRestartSafe === false &&
          isRecoveryFailureReason(stats.recovery.reason)
        ? ({ serviceRestartSafe: false, reason: stats.recovery.reason } as const)
        : undefined;
  return {
    attemptId: stats.handoffId?.trim() || `recorded:${payload.ts}`,
    result: {
      status: payload.status,
      mode,
      ...(typeof stats.reason === "string" ? { reason: stats.reason } : {}),
      ...(readIdentity(stats.before) ? { before: readIdentity(stats.before) } : {}),
      ...(readIdentity(stats.after) ? { after: readIdentity(stats.after) } : {}),
      steps: (stats.steps ?? []).map((step) => ({
        name: step.name,
        command: "",
        cwd: "",
        durationMs: step.durationMs ?? 0,
        exitCode: step.log?.exitCode ?? null,
      })),
      durationMs: stats.durationMs ?? 0,
      ...(recovery ? { recovery } : {}),
    },
    ...(stats.target ? { target: stats.target } : {}),
  };
}

export const updateReportHandler: GatewayRequestHandlers["update.report"] = async ({
  params,
  respond,
}) => {
  if (!assertValidParams(params, validateUpdateReportParams, "update.report", respond)) {
    return;
  }
  try {
    const sentinel =
      getLatestUpdateRestartSentinel() ?? (await refreshLatestUpdateRestartSentinel());
    const input = sentinel ? projectReportInput(sentinel) : null;
    if (!input || input.attemptId !== params.attemptId) {
      respond(false, undefined, {
        code: "INVALID_REQUEST",
        message: "This failed update attempt is stale or unavailable.",
      });
      return;
    }
    const prepared = await prepareUpdateFailureReport(input);
    const result =
      params.action === "preview"
        ? {
            status: "ready" as const,
            attemptId: prepared.attemptId,
            body: prepared.body,
            previewDigest: prepared.previewDigest,
            savedReportPath: prepared.savedReportPath,
            title: prepared.title,
          }
        : await submitUpdateFailureReport(prepared, params.previewDigest);
    if (!validateUpdateReportResult(result)) {
      respond(false, undefined, {
        code: "UNAVAILABLE",
        message: "update report status is temporarily unavailable",
      });
      return;
    }
    respond(true, result);
  } catch {
    respond(false, undefined, {
      code: "INVALID_REQUEST",
      message: "Update report could not be prepared safely.",
    });
  }
};

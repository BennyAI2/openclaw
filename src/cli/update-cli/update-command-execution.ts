import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { DevUpdateTarget } from "../../infra/update-dev-target.js";
import type { ResolvedGlobalInstallTarget } from "../../infra/update-global.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { defaultRuntime } from "../../runtime.js";
import type { OpenClawSchemaVersions } from "../../state/openclaw-schema-versions.js";
import { replaceCliName, resolveCliName } from "../cli-name.js";
import { formatCliCommand } from "../command-format.js";
import { createUpdateProgress } from "./progress.js";
import {
  checkTargetDatabaseSchemas,
  formatSchemaRefusalLines,
  hasSchemaRefusal,
} from "./schema-preflight.js";
import {
  resolveGitInstallDir,
  UpdatePreMutationError,
  type UpdateCommandOptions,
} from "./shared.js";
import { createBeforeGitMutation, updateGitInstall } from "./update-command-git.js";
import {
  captureOwnedManagedUpdateContext,
  type OwnedManagedUpdateContext,
} from "./update-command-managed-context.js";
import { createUpdateMigrationBackup } from "./update-command-migration-backup.js";
import { runPackageInstallUpdate } from "./update-command-package.js";
import type { ManagedServiceRootRedirect } from "./update-command-service-plan.js";
import {
  createAggregateErrorWithCause,
  maybeRestartServiceAfterFailedMutableUpdate,
  maybeResumeWindowsTaskAutoStartAfterPackageUpdate,
  maybeStopManagedServiceBeforeMutableUpdate,
  resolvePreparedGatewayUpdatePolicy,
  shouldBlockMutableUpdateFromGatewayServiceEnv,
  UpdateCommandAbort,
  type PreManagedServiceStop,
  type UpdateCommandRecoveryState,
} from "./update-command-service.js";

const CLI_NAME = resolveCliName();

type MutableUpdateExecutionResult = {
  result: UpdateRunResult;
  preManagedServiceStop: PreManagedServiceStop | undefined;
  ownedManagedUpdateContext: OwnedManagedUpdateContext | undefined;
};

export async function executeMutableUpdate(params: {
  root: string;
  installKind: "git" | "package" | "unknown";
  updateInstallKind: "git" | "package" | "unknown";
  switchToGit: boolean;
  timeoutMs: number | undefined;
  updateStepTimeoutMs: number;
  startedAt: number;
  progress: ReturnType<typeof createUpdateProgress>["progress"];
  stop: () => void;
  channel: "stable" | "extended-stable" | "beta" | "dev";
  tag: string;
  opts: UpdateCommandOptions;
  shouldRestart: boolean;
  devTarget?: DevUpdateTarget;
  packageInstallSpec: string | null;
  packageInstallEnv?: NodeJS.ProcessEnv;
  packageInstallTarget?: ResolvedGlobalInstallTarget;
  packageTargetSchemaVersions?: OpenClawSchemaVersions;
  packageUpdateNodeRunner?: string;
  managedServiceNodeRunner?: string;
  managedServiceRootRedirect: ManagedServiceRootRedirect | null;
  invocationCwd?: string;
  recoveryState: UpdateCommandRecoveryState;
  config: OpenClawConfig;
}): Promise<MutableUpdateExecutionResult | null> {
  let preManagedServiceStop: PreManagedServiceStop | undefined;
  let ownedManagedUpdateContext: OwnedManagedUpdateContext | undefined;
  const getTargetDatabaseSchemaContext = () => ({
    config:
      ownedManagedUpdateContext?.configSnapshot.sourceConfig ??
      ownedManagedUpdateContext?.configSnapshot.config ??
      params.config,
    env: ownedManagedUpdateContext?.env ?? process.env,
  });
  let migrationBackup: UpdateRunResult["migrationBackup"];
  let migrationBackupStep: UpdateRunResult["steps"][number] | undefined;
  let databaseMigrationStarted = false;
  const recoverStoppedService = () =>
    maybeRestartServiceAfterFailedMutableUpdate({
      preManagedServiceStop,
      jsonMode: Boolean(params.opts.json),
      nodeRunner: params.packageUpdateNodeRunner,
      timeoutMs: params.updateStepTimeoutMs,
      invocationCwd: params.invocationCwd,
    });
  const gitMutationRoots =
    params.updateInstallKind === "git"
      ? params.switchToGit
        ? [params.root, resolveGitInstallDir()]
        : [params.root]
      : null;
  const stopManagedServiceBeforeMutableUpdate = async (
    mutationRoots: readonly string[] = [params.root],
    phase: "inspect" | "prepare" = "prepare",
  ) => {
    if (params.updateInstallKind !== "package" && params.updateInstallKind !== "git") {
      return;
    }
    try {
      const uniqueMutationRoots = Array.from(new Set(mutationRoots));
      for (const mutationRoot of uniqueMutationRoots) {
        preManagedServiceStop = await maybeStopManagedServiceBeforeMutableUpdate({
          updateInstallKind: params.updateInstallKind,
          root: mutationRoot,
          shouldRestart: params.shouldRestart,
          jsonMode: Boolean(params.opts.json),
          timeoutMs: params.updateStepTimeoutMs,
          phase,
        });
        if (preManagedServiceStop.windowsTaskAutoStartRecovery) {
          params.recoveryState.windowsTaskAutoStartRecovery =
            preManagedServiceStop.windowsTaskAutoStartRecovery;
        }
        if (
          preManagedServiceStop.stopped ||
          preManagedServiceStop.blockMessage ||
          shouldBlockMutableUpdateFromGatewayServiceEnv({ preManagedServiceStop }) ||
          !preManagedServiceStop.inspected ||
          !preManagedServiceStop.running ||
          !params.shouldRestart
        ) {
          break;
        }
      }
    } catch (err) {
      if (err instanceof UpdateCommandAbort || err instanceof UpdatePreMutationError) {
        throw err;
      }
      params.stop();
      throw new Error(`Failed to stop managed gateway service before update: ${String(err)}`, {
        cause: err,
      });
    }

    if (phase === "inspect" && preManagedServiceStop?.serviceUpdateVerdict?.kind === "foreign") {
      preManagedServiceStop = undefined;
    }

    try {
      ownedManagedUpdateContext = await captureOwnedManagedUpdateContext({
        stopState: preManagedServiceStop,
        processEnv: process.env,
        invocationCwd: params.invocationCwd,
      });
      if (ownedManagedUpdateContext) {
        params.recoveryState.triageTarget.env = ownedManagedUpdateContext.env;
      }
    } catch (err) {
      params.stop();
      await recoverStoppedService();
      throw new Error(`Failed to capture managed gateway update state: ${String(err)}`, {
        cause: err,
      });
    }

    if (shouldBlockMutableUpdateFromGatewayServiceEnv({ preManagedServiceStop })) {
      params.stop();
      const updateLabel = params.updateInstallKind === "git" ? "Git updates" : "Package updates";
      throw new UpdatePreMutationError(
        "managed-service-preflight",
        [
          `${updateLabel} cannot run from inside the gateway service process.`,
          "That path replaces the active OpenClaw dist tree while the live gateway may still lazy-load old chunks.",
          `Run \`${replaceCliName(formatCliCommand("openclaw update"), CLI_NAME)}\` from a shell outside the gateway service, or stop the gateway service first and then update.`,
        ].join("\n"),
      );
    }

    if (preManagedServiceStop?.blockMessage) {
      params.stop();
      throw new UpdatePreMutationError(
        "managed-service-preflight",
        preManagedServiceStop.blockMessage,
      );
    }
  };

  if (params.updateInstallKind === "package" || params.updateInstallKind === "git") {
    try {
      await stopManagedServiceBeforeMutableUpdate(
        gitMutationRoots ?? undefined,
        params.updateInstallKind === "git" ? "inspect" : "prepare",
      );
    } catch (err) {
      if (err instanceof UpdateCommandAbort) {
        return null;
      }
      throw err;
    }
  }

  const postStopPackageSchemaPreflight =
    params.updateInstallKind === "package"
      ? checkTargetDatabaseSchemas(
          params.packageTargetSchemaVersions,
          getTargetDatabaseSchemaContext(),
        )
      : { incompatible: [], indeterminate: [] };
  const prepareMigrationBackup = async (
    schemaPreflight: typeof postStopPackageSchemaPreflight,
    serviceEnv: NodeJS.ProcessEnv,
  ) => {
    const outcome = await createUpdateMigrationBackup({
      root: params.root,
      schemaPreflight,
      timeoutMs: params.updateStepTimeoutMs,
      progress: params.progress,
      serviceEnv,
      invocationCwd: params.invocationCwd,
    });
    if (outcome.status === "not-needed") {
      return;
    }
    migrationBackupStep = outcome.step;
    if (outcome.status === "failed") {
      throw new UpdatePreMutationError(
        "pre-migration-backup-failed",
        outcome.step.stderrTail ?? "Pre-migration backup failed.",
      );
    }
    migrationBackup = outcome.backup;
  };
  const attachMigrationBackup = (updateResult: UpdateRunResult): UpdateRunResult => {
    const steps = migrationBackupStep
      ? [migrationBackupStep, ...updateResult.steps]
      : updateResult.steps;
    const attachedBackup = migrationBackup
      ? { ...migrationBackup, migrationStarted: databaseMigrationStarted }
      : undefined;
    return {
      ...updateResult,
      steps,
      ...(attachedBackup ? { migrationBackup: attachedBackup } : {}),
      ...(attachedBackup && updateResult.status === "error" && databaseMigrationStarted
        ? {
            recovery: {
              serviceRestartSafe: false as const,
              reason: "database-migration-uncertain" as const,
            },
          }
        : {}),
    };
  };
  let result: UpdateRunResult;
  try {
    if (hasSchemaRefusal(postStopPackageSchemaPreflight)) {
      throw new UpdatePreMutationError(
        "database-schema-preflight",
        formatSchemaRefusalLines(postStopPackageSchemaPreflight).join("\n"),
      );
    }
    if (params.updateInstallKind === "package") {
      await prepareMigrationBackup(
        postStopPackageSchemaPreflight,
        preManagedServiceStop?.serviceEnv ?? process.env,
      );
    }
    result =
      params.updateInstallKind === "package"
        ? await runPackageInstallUpdate({
            root: params.root,
            installKind: params.installKind,
            tag: params.tag,
            installSpec: params.packageInstallSpec ?? undefined,
            timeoutMs: params.updateStepTimeoutMs,
            startedAt: params.startedAt,
            progress: params.progress,
            jsonMode: Boolean(params.opts.json),
            ...resolvePreparedGatewayUpdatePolicy(preManagedServiceStop, params.shouldRestart),
            managedServiceEnv: preManagedServiceStop?.serviceEnv,
            invocationCwd: params.invocationCwd,
            honorPackageRoot:
              params.managedServiceRootRedirect !== null ||
              params.managedServiceNodeRunner !== undefined,
            nodeRunner: params.packageUpdateNodeRunner,
            installEnv: params.packageInstallEnv,
            installTarget: params.packageInstallTarget,
            onDatabaseMigrationStart: () => {
              databaseMigrationStarted = true;
            },
          })
        : await updateGitInstall({
            root: params.root,
            switchToGit: params.switchToGit,
            installKind: params.installKind,
            timeoutMs: params.timeoutMs,
            startedAt: params.startedAt,
            progress: params.progress,
            channel: params.channel,
            tag: params.tag,
            devTarget: params.devTarget,
            beforeGitMutation:
              params.updateInstallKind === "git"
                ? createBeforeGitMutation({
                    roots: gitMutationRoots ?? [params.root],
                    shouldRestart: params.shouldRestart,
                    stopManagedService: stopManagedServiceBeforeMutableUpdate,
                    getPreManagedServiceStop: () => preManagedServiceStop,
                    getDatabaseSchemaContext: getTargetDatabaseSchemaContext,
                    switchToGit: params.switchToGit,
                    beforeMutation: prepareMigrationBackup,
                  })
                : undefined,
            allowGatewayServiceRepair: false,
            allowGatewayActivation: false,
            onDatabaseMigrationStart: () => {
              databaseMigrationStarted = true;
            },
          });
  } catch (err) {
    params.stop();
    if (err instanceof UpdatePreMutationError) {
      defaultRuntime.error(err.message);
      return {
        result: attachMigrationBackup({
          status: "error",
          mode:
            params.updateInstallKind === "git"
              ? "git"
              : (params.packageInstallTarget?.manager ?? "unknown"),
          root: params.root,
          reason: err.reason,
          recovery: { serviceRestartSafe: true },
          steps:
            err.reason === "pre-migration-backup-failed" && migrationBackupStep
              ? []
              : [
                  {
                    name: err.reason,
                    command: err.reason,
                    cwd: params.root,
                    exitCode: 1,
                    durationMs: 0,
                    stderrTail: err.message,
                  },
                ],
          durationMs: Date.now() - params.startedAt,
        }),
        preManagedServiceStop,
        ownedManagedUpdateContext,
      };
    }
    if (err instanceof UpdateCommandAbort) {
      return null;
    }
    // Unexpected mutation failures have no verified rollback. Carry the owner's
    // restart verdict into diagnostics while preserving the original exception.
    params.recoveryState.triageTarget.failureResult = attachMigrationBackup({
      status: "error",
      mode:
        params.updateInstallKind === "git"
          ? "git"
          : (params.packageInstallTarget?.manager ?? "unknown"),
      root: params.root,
      recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
      steps: [],
      durationMs: Date.now() - params.startedAt,
    });
    try {
      await maybeResumeWindowsTaskAutoStartAfterPackageUpdate(preManagedServiceStop);
    } catch (resumeErr) {
      params.recoveryState.windowsTaskAutoStartRecovery?.complete();
      params.recoveryState.windowsTaskAutoStartRecovery = undefined;
      throw createAggregateErrorWithCause(
        [err, resumeErr],
        `Update failed (${String(err)}) and Windows Scheduled Task autostart could not be restored (${String(resumeErr)})`,
        err,
      );
    }
    // Only the mutation owner can prove rollback. Unexpected exceptions cannot
    // authorize restarting a partially replaced installation.
    defaultRuntime.error(
      "Update recovery is unverified. Inspect `openclaw gateway status --deep` and repair the installation before restarting.",
    );
    throw err;
  }

  return {
    result: attachMigrationBackup(result),
    preManagedServiceStop,
    ownedManagedUpdateContext,
  };
}

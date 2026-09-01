import fs from "node:fs/promises";
import path from "node:path";
import { buildBackupArchiveBasename } from "../../commands/backup-shared.js";
import { resolveStateDir } from "../../config/paths.js";
import { resolveGatewayInstallEntrypoint } from "../../daemon/gateway-entrypoint.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { applyPrivateModeSync } from "../../infra/private-mode.js";
import type {
  UpdateMigrationBackup,
  UpdateStepProgress,
  UpdateStepResult,
} from "../../infra/update-runner.js";
import type { OpenClawDatabaseSchemaPreflight } from "../../state/openclaw-database-preflight.js";
import { resolveNodeRunner, runUpdateStep } from "./shared.js";
import {
  resolvePostInstallDoctorEnv,
  stripGatewayServiceMarkerEnv,
} from "./update-command-service-env.js";

type UpdateMigrationBackupResult =
  | { status: "not-needed" }
  | { status: "created"; backup: UpdateMigrationBackup; step: UpdateStepResult }
  | { status: "failed"; step: UpdateStepResult };

export function hasRequiredSchemaMigrations(
  schemaPreflight: OpenClawDatabaseSchemaPreflight,
): boolean {
  return (schemaPreflight.migrationRequired?.length ?? 0) > 0;
}

function failedBackupStep(params: {
  root: string;
  archivePath?: string;
  error: unknown;
}): UpdateStepResult {
  return {
    name: "pre-migration backup",
    command: "openclaw backup create --verify --no-include-workspace",
    cwd: params.root,
    durationMs: 0,
    exitCode: 1,
    stderrTail: [
      formatErrorMessage(params.error),
      params.archivePath ? `Backup target: ${params.archivePath}` : undefined,
      "Update stopped before code or database mutation.",
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n"),
  };
}

/** Create the verified recovery point before a target can advance a database schema. */
export async function createUpdateMigrationBackup(params: {
  root: string;
  schemaPreflight: OpenClawDatabaseSchemaPreflight;
  timeoutMs: number;
  progress?: UpdateStepProgress;
  serviceEnv?: NodeJS.ProcessEnv;
  invocationCwd?: string;
  nodeRunner?: string;
  nowMs?: number;
}): Promise<UpdateMigrationBackupResult> {
  const databases = params.schemaPreflight.migrationRequired ?? [];
  if (!hasRequiredSchemaMigrations(params.schemaPreflight)) {
    return { status: "not-needed" };
  }

  const commandEnv = stripGatewayServiceMarkerEnv(
    resolvePostInstallDoctorEnv({
      serviceEnv: params.serviceEnv,
      invocationCwd: params.invocationCwd,
    }),
  );
  const stateDir = path.resolve(resolveStateDir(commandEnv));
  const backupDir = `${stateDir}.update-backups`;
  const archivePath = path.join(backupDir, buildBackupArchiveBasename(params.nowMs ?? Date.now()));
  let entryPath: string | undefined;
  try {
    await fs.mkdir(backupDir, { recursive: true, mode: 0o700 });
    const privateMode = applyPrivateModeSync(backupDir, 0o700);
    if (!privateMode.applied && ((await fs.stat(backupDir)).mode & 0o077) !== 0) {
      throw new Error(`Filesystem cannot enforce private permissions on ${backupDir}`, {
        cause: privateMode.error,
      });
    }
    entryPath = await resolveGatewayInstallEntrypoint(params.root);
  } catch (error) {
    return { status: "failed", step: failedBackupStep({ root: params.root, archivePath, error }) };
  }
  if (!entryPath) {
    return {
      status: "failed",
      step: failedBackupStep({
        root: params.root,
        archivePath,
        error: new Error("Current OpenClaw entrypoint was not found for the backup command."),
      }),
    };
  }

  const step = await runUpdateStep({
    name: "pre-migration backup",
    argv: [
      params.nodeRunner ?? resolveNodeRunner(),
      entryPath,
      "backup",
      "create",
      "--output",
      archivePath,
      "--verify",
      "--no-include-workspace",
      "--json",
    ],
    cwd: params.root,
    env: commandEnv,
    timeoutMs: params.timeoutMs,
    progress: params.progress,
  });
  if (step.exitCode !== 0) {
    return {
      status: "failed",
      step: {
        ...step,
        stderrTail: [
          step.stderrTail,
          `Backup target: ${archivePath}`,
          "Update stopped before code or database mutation.",
        ]
          .filter((line): line is string => Boolean(line))
          .join("\n"),
      },
    };
  }

  try {
    const archive = await fs.stat(archivePath);
    if (!archive.isFile() || archive.size === 0) {
      throw new Error(
        `Verified backup command did not publish a non-empty archive: ${archivePath}`,
      );
    }
  } catch (error) {
    return { status: "failed", step: failedBackupStep({ root: params.root, archivePath, error }) };
  }

  return {
    status: "created",
    backup: { archivePath, databases: [...databases], migrationStarted: false, verified: true },
    step: {
      ...step,
      stdoutTail: `Verified pre-migration backup: ${archivePath}`,
      stderrTail: null,
    },
  };
}

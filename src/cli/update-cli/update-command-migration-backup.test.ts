import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawDatabaseSchemaPreflight } from "../../state/openclaw-database-preflight.js";

const mocks = vi.hoisted(() => ({
  resolveGatewayInstallEntrypoint: vi.fn(async () => "/opt/openclaw/openclaw.mjs"),
  runUpdateStep: vi.fn(),
}));

vi.mock("../../daemon/gateway-entrypoint.js", () => ({
  resolveGatewayInstallEntrypoint: mocks.resolveGatewayInstallEntrypoint,
}));

vi.mock("./shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared.js")>()),
  resolveNodeRunner: () => "/usr/bin/node",
  runUpdateStep: mocks.runUpdateStep,
}));

import {
  createUpdateMigrationBackup,
  hasRequiredSchemaMigrations,
} from "./update-command-migration-backup.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function migrationPreflight(): OpenClawDatabaseSchemaPreflight {
  return {
    incompatible: [],
    indeterminate: [],
    migrationRequired: [
      {
        kind: "state",
        path: "/state/openclaw.sqlite",
        foundVersion: 4,
        supportedVersion: 5,
      },
    ],
  };
}

describe("update pre-migration backup", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.resolveGatewayInstallEntrypoint.mockResolvedValue("/opt/openclaw/openclaw.mjs");
  });

  it("skips backup when every database already matches the target schema", async () => {
    const preflight = { incompatible: [], indeterminate: [] };

    await expect(
      createUpdateMigrationBackup({
        root: "/opt/openclaw",
        schemaPreflight: preflight,
        timeoutMs: 1_000,
      }),
    ).resolves.toEqual({ status: "not-needed" });
    expect(hasRequiredSchemaMigrations(preflight)).toBe(false);
    expect(mocks.runUpdateStep).not.toHaveBeenCalled();
  });

  it("creates and verifies a workspace-free backup before migration", async () => {
    const stateDir = tempDirs.make("openclaw-update-backup-state-");
    const nowMs = Date.UTC(2026, 8, 1, 12, 0, 0);
    mocks.runUpdateStep.mockImplementationOnce(async (params: { argv: string[] }) => {
      const outputIndex = params.argv.indexOf("--output");
      const archivePath = params.argv[outputIndex + 1];
      if (!archivePath) {
        throw new Error("missing backup output path");
      }
      await fs.writeFile(archivePath, "verified backup");
      return {
        name: "pre-migration backup",
        command: params.argv.join(" "),
        cwd: "/opt/openclaw",
        durationMs: 25,
        exitCode: 0,
        stdoutTail: "{}",
        stderrTail: null,
      };
    });

    const result = await createUpdateMigrationBackup({
      root: "/opt/openclaw",
      schemaPreflight: migrationPreflight(),
      serviceEnv: { OPENCLAW_STATE_DIR: stateDir },
      timeoutMs: 10_000,
      nowMs,
    });

    expect(result).toMatchObject({
      status: "created",
      backup: {
        verified: true,
        migrationStarted: false,
        databases: migrationPreflight().migrationRequired,
      },
      step: { exitCode: 0 },
    });
    if (result.status !== "created") {
      throw new Error("expected a created migration backup");
    }
    expect(result.backup.archivePath).toContain(`${path.basename(stateDir)}.update-backups`);
    expect((await fs.stat(result.backup.archivePath)).size).toBeGreaterThan(0);
    expect(mocks.runUpdateStep).toHaveBeenCalledWith(
      expect.objectContaining({
        argv: [
          "/usr/bin/node",
          "/opt/openclaw/openclaw.mjs",
          "backup",
          "create",
          "--output",
          result.backup.archivePath,
          "--verify",
          "--no-include-workspace",
          "--json",
        ],
        env: expect.objectContaining({ OPENCLAW_STATE_DIR: stateDir }),
      }),
    );
    if (process.platform !== "win32") {
      const mode = (await fs.stat(path.dirname(result.backup.archivePath))).mode & 0o777;
      expect(mode).toBe(0o700);
    }
  });

  it("fails closed when backup creation fails", async () => {
    const stateDir = tempDirs.make("openclaw-update-backup-failure-");
    mocks.runUpdateStep.mockResolvedValueOnce({
      name: "pre-migration backup",
      command: "openclaw backup create",
      cwd: "/opt/openclaw",
      durationMs: 25,
      exitCode: 1,
      stderrTail: "disk full",
    });

    const result = await createUpdateMigrationBackup({
      root: "/opt/openclaw",
      schemaPreflight: migrationPreflight(),
      serviceEnv: { OPENCLAW_STATE_DIR: stateDir },
      timeoutMs: 10_000,
    });

    expect(result).toMatchObject({
      status: "failed",
      step: {
        exitCode: 1,
        stderrTail: expect.stringMatching(/disk full.*stopped before code or database mutation/su),
      },
    });
  });
});

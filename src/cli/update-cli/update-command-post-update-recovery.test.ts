import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { defaultRuntime } from "../../runtime.js";

const mocks = vi.hoisted(() => ({
  triage: vi.fn(async () => undefined),
  printResult: vi.fn(),
  restart: vi.fn(async () => undefined),
  restoreWindowsAutoStart: vi.fn(async () => true),
  freshProcess: vi.fn(),
  writeSentinel: vi.fn<
    typeof import("./update-command-result.js").writeControlPlaneUpdateRestartSentinelBestEffort
  >(async () => undefined),
}));

vi.mock("../../commands/triage-failure.js", () => ({ triageAfterFailure: mocks.triage }));
vi.mock("./progress.js", () => ({ printResult: mocks.printResult }));
vi.mock("./update-command-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-service.js")>()),
  maybeRestartServiceAfterFailedMutableUpdate: mocks.restart,
  maybeResumeWindowsTaskAutoStartAfterPackageUpdate: mocks.restoreWindowsAutoStart,
}));
vi.mock("./update-command-post-core.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-post-core.js")>()),
  continuePostCoreUpdateInFreshProcess: mocks.freshProcess,
}));
vi.mock("./update-command-result.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-result.js")>()),
  writeControlPlaneUpdateRestartSentinelBestEffort: mocks.writeSentinel,
}));

import { finishUpdate } from "./update-command-post-update.js";
import { successfulPluginUpdate } from "./update-command-post-update.test-support.js";

type FinishUpdateParams = Parameters<typeof finishUpdate>[0];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function failedResult(recovery: UpdateRunResult["recovery"]): UpdateRunResult {
  return {
    status: "error",
    mode: "git",
    reason: "doctor-failed",
    root: "/repo",
    recovery,
    steps: [],
    durationMs: 1,
  };
}

async function finishFailedUpdate(
  result: UpdateRunResult,
  options: { json?: boolean; stopped?: boolean; root?: string; installKindChanged?: boolean } = {},
): Promise<void> {
  await finishUpdate({
    root: options.root,
    installKindChanged: options.installKindChanged,
    mutationStarted: result.recovery !== undefined,
    result,
    opts: { json: options.json },
    showProgress: false,
    startedAt: Date.now(),
    preManagedServiceStop: { stopped: options.stopped ?? true, serviceEnv: {} },
    controlPlaneUpdateSentinelMeta: undefined,
  } as unknown as FinishUpdateParams);
}

async function finishSkippedUpdate(reason: string): Promise<void> {
  await finishUpdate({
    result: {
      status: "skipped",
      mode: reason === "dirty" ? "git" : "unknown",
      reason,
      steps: [],
      durationMs: 1,
    },
    opts: {},
    showProgress: false,
    startedAt: Date.now(),
    controlPlaneUpdateSentinelMeta: undefined,
  } as unknown as FinishUpdateParams);
}

describe("skipped update exit status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined as never);
    vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);
    vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);
  });

  it.each([
    ["dirty", 1],
    ["not-git-install", 0],
  ] as const)("handles %s with exit %i", async (reason, exitCode) => {
    await finishSkippedUpdate(reason);
    if (reason === "dirty") {
      expect(defaultRuntime.error).toHaveBeenCalledWith(
        expect.stringContaining("Update blocked: local files are edited"),
      );
    }
    expect(defaultRuntime.exit).toHaveBeenCalledWith(exitCode);
    expect(mocks.triage).not.toHaveBeenCalled();
  });
});

describe("failed Git update recovery restart", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined as never);
  });

  it.each([false, true])(
    "triages the invocation installation after Git candidate exposure=%s",
    async (exposed) => {
      const scratch = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), "triage-producer-")),
      );
      const invocation = path.join(scratch, "package");
      const candidate = path.join(scratch, "checkout");
      try {
        await fs.mkdir(candidate);
        if (exposed) {
          await fs.symlink(candidate, invocation, "dir");
        } else {
          await fs.mkdir(invocation);
        }
        const result = {
          ...failedResult({ serviceRestartSafe: false, reason: "runtime-verification-failed" }),
          root: candidate,
        };
        await finishFailedUpdate(result, {
          json: true,
          root: invocation,
          installKindChanged: true,
        });
        const failure = (
          mocks.triage.mock.lastCall as unknown as [
            unknown,
            { installationRoot: string; gateway: string },
          ]
        )[1];
        expect(await fs.realpath(failure.installationRoot)).toBe(exposed ? candidate : invocation);
        expect(failure.gateway).toBe("preserve");
        expect(mocks.printResult.mock.lastCall?.[0].root).toBe(candidate);
        expect(mocks.writeSentinel.mock.lastCall?.[0].result.root).toBe(candidate);
      } finally {
        await fs.rm(scratch, { recursive: true, force: true });
      }
    },
  );

  it.each(["error", "skipped"] as const)(
    "records the %s outcome before recovery starts the Gateway",
    async (status) => {
      let now = 1_000;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      mocks.restart.mockImplementationOnce(async () => {
        expect(mocks.writeSentinel.mock.lastCall?.[0].result).toMatchObject({ status });
        expect(mocks.writeSentinel.mock.lastCall?.[0].result.durationMs).toBe(0);
        expect(mocks.printResult).not.toHaveBeenCalled();
        now += 200;
      });

      await finishFailedUpdate({ ...failedResult({ serviceRestartSafe: true }), status });

      expect(mocks.restart).toHaveBeenCalledOnce();
      expect(mocks.writeSentinel).toHaveBeenCalledOnce();
      expect(mocks.writeSentinel.mock.lastCall?.[0].result.durationMs).toBe(0);
      expect(mocks.printResult).toHaveBeenCalledOnce();
      expect(mocks.printResult.mock.lastCall?.[0]).toMatchObject({ status, durationMs: 200 });
      expect(mocks.triage).toHaveBeenCalledTimes(status === "error" ? 1 : 0);
    },
  );

  it("leaves a managed Gateway stopped after unverified rollback recovery", async () => {
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);

    await finishFailedUpdate(
      failedResult({ serviceRestartSafe: false, reason: "runtime-verification-failed" }),
    );

    expect(mocks.restart).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Managed gateway remains stopped"));
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("repair the checkout or installation"),
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining("rerun `openclaw update`"));
  });

  it("does not restart when the mutation owner returned no recovery verdict", async () => {
    vi.stubEnv("OPENCLAW_UPDATE_RUN_HANDOFF", "1");
    await finishFailedUpdate(failedResult(undefined), { json: true, stopped: false });
    expect(mocks.restart).not.toHaveBeenCalled();
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it.each([
    { handoff: false, restoreFails: false, safe: false, stopped: true, expected: 1 },
    { handoff: true, restoreFails: false, safe: false, stopped: false, expected: 1 },
    { handoff: true, restoreFails: true, safe: false, stopped: true, expected: 1 },
    { handoff: true, restoreFails: false, safe: true, stopped: true, expected: 1 },
    { handoff: true, restoreFails: false, safe: true, stopped: false, expected: 80 },
    { handoff: true, restoreFails: true, safe: true, stopped: false, expected: 1 },
  ])(
    "delegates only verified, unhandled recovery ($handoff, $restoreFails, $safe, $stopped)",
    async ({ handoff, restoreFails, safe, stopped, expected }) => {
      vi.stubEnv("OPENCLAW_UPDATE_RUN_HANDOFF", handoff ? "1" : undefined);
      if (restoreFails) {
        mocks.restoreWindowsAutoStart.mockRejectedValueOnce(new Error("restore failed"));
      }
      await finishFailedUpdate(
        failedResult(
          safe
            ? { serviceRestartSafe: true }
            : { serviceRestartSafe: false, reason: "runtime-verification-failed" },
        ),
        { json: true, stopped },
      );
      expect(defaultRuntime.exit).toHaveBeenCalledWith(expected);
      expect(mocks.restart).toHaveBeenCalledTimes(safe && !restoreFails ? 1 : 0);
      expect(mocks.writeSentinel.mock.lastCall?.[0].result.recovery?.serviceRestartSafe).toBe(safe);
    },
  );

  it.each([false, true])(
    "never forwards a nested recovery exit (autostart failure: %s)",
    async (restoreFails) => {
      vi.stubEnv("OPENCLAW_UPDATE_RUN_HANDOFF", "1");
      mocks.freshProcess.mockResolvedValueOnce({ resumed: false, exitCode: 80 });
      if (restoreFails) {
        mocks.restoreWindowsAutoStart.mockRejectedValueOnce(new Error("restore failed"));
      }
      await finishUpdate({
        result: { status: "ok", mode: "npm", root: "/repo", steps: [], durationMs: 1 },
        root: "/repo",
        configSnapshot: { valid: false },
        opts: { json: true },
        showProgress: false,
        startedAt: Date.now(),
        controlPlaneUpdateSentinelMeta: undefined,
      } as unknown as FinishUpdateParams);
      expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
      expect(mocks.restart).not.toHaveBeenCalled();
    },
  );

  it("explains how to recover from a dirty rollback checkout", async () => {
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);

    await finishFailedUpdate(
      failedResult({ serviceRestartSafe: false, reason: "rollback-checkout-dirty" }),
    );

    const output = log.mock.calls.flat().map(String).join("\n");
    expect(mocks.restart).not.toHaveBeenCalled();
    expect(output).toContain("From the update root shown above");
    expect(output).toContain("git status --short");
    expect(output).toContain("resolve the reported changes");
    expect(output).toContain("rerun `openclaw update`");
    expect(output).toContain("Keep the gateway stopped until the update succeeds");
    expect(mocks.triage).not.toHaveBeenCalled();
  });

  it.each(["prompt", "artifact"])(
    "leaves a %s capability refusal operator-owned after failed convergence",
    async (owner) => {
      await finishFailedUpdate({
        ...failedResult({ serviceRestartSafe: true }),
        reason: "post-update-plugins",
        postUpdate: {
          plugins: {
            ...successfulPluginUpdate,
            status: "error",
            ...(owner === "prompt"
              ? { capabilityConsentRequired: true as const }
              : {
                  npm: {
                    changed: false,
                    outcomes: [
                      {
                        pluginId: "synthetic",
                        status: "error",
                        code: "PLUGIN_CAPABILITY_CONSENT_REQUIRED",
                        message: "Staged capabilities require review",
                      },
                    ],
                  },
                }),
          },
        },
      });
      expect(mocks.triage).not.toHaveBeenCalled();
      expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
    },
  );

  it.each([
    "database-schema-preflight",
    "pnpm isolated install preflight",
    "npm lifecycle policy preflight",
  ])("does not auto-repair the %s refusal", async (reason) => {
    await finishFailedUpdate({ ...failedResult(undefined), mode: "npm", reason });
    expect(mocks.triage).not.toHaveBeenCalled();
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("preserves the active profile in unsafe recovery guidance", async () => {
    vi.stubEnv("OPENCLAW_PROFILE", "work");
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);

    await finishFailedUpdate(
      failedResult({ serviceRestartSafe: false, reason: "rollback-checkout-dirty" }),
    );

    const output = log.mock.calls.flat().map(String).join("\n");
    expect(output).toContain("rerun `openclaw --profile work update`");
    expect(output).not.toContain("rerun `openclaw update`");
  });

  it("does not claim an unsafe recovery stopped a service that was already down", async () => {
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);

    await finishFailedUpdate(
      failedResult({ serviceRestartSafe: false, reason: "rollback-checkout-dirty" }),
      { stopped: false },
    );

    const output = log.mock.calls.flat().map(String).join("\n");
    expect(output).toContain("Update recovery could not prove a runnable installation");
    expect(output).toContain("resolve the reported changes");
    expect(output).not.toContain("remains stopped");
    expect(output).not.toContain("Keep the gateway stopped");
  });

  it("keeps structured JSON recovery free of prose guidance", async () => {
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);
    const result = failedResult({
      serviceRestartSafe: false,
      reason: "rollback-checkout-dirty",
    });

    await finishFailedUpdate(result, { json: true });

    expect(mocks.printResult).toHaveBeenCalledWith(
      expect.objectContaining({ ...result, durationMs: expect.any(Number) }),
      expect.objectContaining({ json: true }),
    );
    expect(mocks.restart).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });
});

describe("failed package update recovery safety", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined as never);
  });

  it.each([
    "global install verify",
    "pnpm package lifecycle marker",
    "pnpm package preinstall",
    "pnpm package postinstall",
    "pnpm package lifecycle finalize",
  ])("keeps the replaced package stopped after %s fails", async (name) => {
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);

    await finishUpdate({
      result: {
        status: "error",
        mode: name.startsWith("pnpm ") ? "pnpm" : "npm",
        reason: "global-install-failed",
        steps: [
          { name: "global update", command: "npm", cwd: "/", durationMs: 1, exitCode: 0 },
          {
            name,
            command: "verify",
            cwd: "/",
            durationMs: 1,
            exitCode: 1,
          },
        ],
        recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
        durationMs: 1,
      },
      opts: {},
      showProgress: false,
      startedAt: Date.now(),
      preManagedServiceStop: { stopped: true, serviceEnv: {} },
      controlPlaneUpdateSentinelMeta: undefined,
    } as unknown as FinishUpdateParams);

    expect(mocks.restart).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Managed gateway remains stopped"));
  });

  it("does not start a Doctor-rejected candidate even after a verified swap", async () => {
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);

    await finishUpdate({
      result: {
        status: "error",
        mode: "npm",
        reason: "doctor-failed",
        steps: [
          { name: "global update", command: "npm", cwd: "/", durationMs: 1, exitCode: 0 },
          { name: "openclaw doctor", command: "doctor", cwd: "/", durationMs: 1, exitCode: 1 },
        ],
        recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
        durationMs: 1,
      },
      opts: {},
      showProgress: false,
      startedAt: Date.now(),
      preManagedServiceStop: { stopped: true, serviceEnv: {} },
      controlPlaneUpdateSentinelMeta: undefined,
    } as unknown as FinishUpdateParams);

    expect(mocks.restart).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Managed gateway remains stopped"));
  });
});

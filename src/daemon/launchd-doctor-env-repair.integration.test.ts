import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { runGatewayServicesHealth } from "../flows/doctor-health-contribution-runners.gateway.js";
import { createDoctorHealthFlowContext } from "../flows/doctor-health-contributions.test-support.js";
import { resolveLaunchAgentEnvFilePath } from "./launchd-service-files.js";
import {
  installLaunchAgent,
  readLaunchAgentRuntime,
  restartLaunchAgent,
  startLaunchAgent,
  stopLaunchAgent,
  uninstallLaunchAgent,
} from "./launchd.js";
import type { GatewayServiceEnv } from "./service-types.js";

const RUNTIME_TIMEOUT_MS = 45_000;

function canRunLaunchdIntegration(): boolean {
  if (process.platform !== "darwin" || typeof process.getuid !== "function") {
    return false;
  }
  const probe = spawnSync("launchctl", ["print", `gui/${process.getuid()}`], {
    encoding: "utf8",
  });
  return probe.status === 0;
}

const describeLaunchdIntegration = canRunLaunchdIntegration() ? describe : describe.skip;

async function waitForRunningPid(env: GatewayServiceEnv, previousPid?: number): Promise<number> {
  let pid: number | undefined;
  await expect
    .poll(
      async () => {
        const runtime = await readLaunchAgentRuntime(env);
        pid = runtime.pid;
        return runtime.status === "running" && pid !== undefined && pid !== previousPid;
      },
      { timeout: RUNTIME_TIMEOUT_MS, interval: 200 },
    )
    .toBe(true);
  if (pid === undefined) {
    throw new Error("LaunchAgent reported running without a pid");
  }
  return pid;
}

function readProcessRegion(pid: number): string | undefined {
  const result = spawnSync("/bin/ps", ["eww", "-p", String(pid), "-o", "command="], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`ps failed (${result.status})`);
  }
  return /(?:^|\s)AWS_REGION=([^\s]*)/.exec(result.stdout)?.[1];
}

describeLaunchdIntegration("LaunchAgent Doctor environment repair", () => {
  it("repairs a restaged service environment during Doctor maintenance", async () => {
    const testId = randomUUID().slice(0, 8);
    const label = `ai.openclaw.doctor-env-${testId}`;
    const env: GatewayServiceEnv = {
      HOME: os.homedir(),
      OPENCLAW_LAUNCHD_LABEL: label,
      OPENCLAW_LOG_PREFIX: `gateway-doctor-env-${testId}`,
    };
    const envFilePath = resolveLaunchAgentEnvFilePath(env, label);
    const stdout = new PassThrough();

    try {
      await installLaunchAgent({
        env,
        stdout,
        programArguments: [process.execPath, "-e", "setInterval(() => {}, 1000);"],
        environment: { AWS_REGION: '"us-east-1"' },
      });
      const installedPid = await waitForRunningPid(env);

      await restartLaunchAgent({ env, stdout });
      const restagedPid = await waitForRunningPid(env, installedPid);
      expect(await fs.readFile(envFilePath, "utf8")).toContain(`export AWS_REGION='"us-east-1"'`);
      expect(readProcessRegion(restagedPid)).toBe('"us-east-1"');

      await stopLaunchAgent({ env, stdout });
      const ctx = createDoctorHealthFlowContext({ env, gatewayMaintenanceActive: true });
      vi.mocked(ctx.prompter.confirmRuntimeRepair).mockResolvedValue(true);
      await runGatewayServicesHealth(ctx);

      expect(await fs.readFile(envFilePath, "utf8")).toContain("export AWS_REGION='us-east-1'");
      await startLaunchAgent({ env, stdout });
      const repairedPid = await waitForRunningPid(env, restagedPid);
      expect(readProcessRegion(repairedPid)).toBe("us-east-1");
    } finally {
      await uninstallLaunchAgent({ env, stdout }).catch(() => undefined);
      await fs.rm(path.dirname(envFilePath), { recursive: true, force: true });
    }
  }, 180_000);
});

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { resolveLaunchAgentEnvFilePath } from "./launchd-service-files.js";
import { readLaunchAgentRuntime, restartLaunchAgent, uninstallLaunchAgent } from "./launchd.js";
import { resolveGatewayStateDir } from "./paths.js";
import type { GatewayServiceEnv } from "./service-types.js";

const CLI_TIMEOUT_MS = 120_000;
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

function runOpenClaw(args: string[], env: NodeJS.ProcessEnv): string {
  const result = spawnSync("pnpm", ["openclaw", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env,
    timeout: CLI_TIMEOUT_MS,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.error || result.status !== 0) {
    throw new Error(
      `openclaw ${args.join(" ")} failed (${result.error?.message ?? result.status}):\n${output}`,
    );
  }
  return output;
}

function runInteractiveDoctor(env: NodeJS.ProcessEnv): string {
  const result = spawnSync(
    "/usr/bin/script",
    ["-q", "/dev/null", "pnpm", "openclaw", "doctor", "--fix"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env,
      input: "\n",
      timeout: CLI_TIMEOUT_MS,
    },
  );
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.error || result.status !== 0) {
    throw new Error(`openclaw doctor --fix failed (${result.error?.message ?? result.status})`);
  }
  return output;
}

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
  it("repairs quote-corrupted service environment after restage", async () => {
    const testId = randomUUID().slice(0, 8);
    const label = `ai.openclaw.doctor-env-${testId}`;
    const port = 21_000 + (Number.parseInt(testId.slice(0, 4), 16) % 1_000);
    const env: GatewayServiceEnv = {
      ...process.env,
      HOME: os.homedir(),
      OPENCLAW_GATEWAY_PORT: String(port),
      OPENCLAW_LAUNCHD_LABEL: label,
      OPENCLAW_LOG_PREFIX: `gateway-doctor-env-${testId}`,
    };
    const cliEnv: NodeJS.ProcessEnv = { ...env };
    const envFilePath = resolveLaunchAgentEnvFilePath(env, label);
    const stdout = new PassThrough();

    try {
      runOpenClaw(["gateway", "install", "--force", "--port", String(port)], cliEnv);
      const installedPid = await waitForRunningPid(env);

      await fs.appendFile(envFilePath, `export AWS_REGION='"us-east-1"'\n`, "utf8");
      await restartLaunchAgent({ env, stdout });
      const restagedPid = await waitForRunningPid(env, installedPid);

      expect(await fs.readFile(envFilePath, "utf8")).toContain(`export AWS_REGION='"us-east-1"'`);
      expect(readProcessRegion(restagedPid)).toBe('"us-east-1"');

      const doctorOutput = runInteractiveDoctor(cliEnv);
      expect(doctorOutput).toContain("#103804");
      expect(await fs.readFile(envFilePath, "utf8")).toContain("export AWS_REGION='us-east-1'");

      await restartLaunchAgent({ env, stdout });
      const repairedPid = await waitForRunningPid(env, restagedPid);
      expect(readProcessRegion(repairedPid)).toBe("us-east-1");
    } finally {
      await uninstallLaunchAgent({ env, stdout }).catch(() => undefined);
      await fs.rm(path.join(resolveGatewayStateDir(env), "service-env", `${label}.env`), {
        force: true,
      });
      await fs.rm(
        path.join(resolveGatewayStateDir(env), "service-env", `${label}-env-wrapper.sh`),
        {
          force: true,
        },
      );
    }
  }, 240_000);
});

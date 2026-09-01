import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { loadAuthProfileStoreWithoutExternalProfiles } from "openclaw/plugin-sdk/agent-runtime";
import { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { describe, expect, it } from "vitest";

const TEST_TIMEOUT_MS = 150_000;
const STARTUP_TIMEOUT_MS = 120_000;
const REQUEST_TIMEOUT_MS = 15_000;

function fakeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.test-signature`;
}

async function writeBundledPluginFixture(root: string, id: "codex" | "openai") {
  const sourceDir = path.resolve("extensions", id);
  const pluginDir = path.join(root, id);
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.copyFile(
    path.join(sourceDir, "openclaw.plugin.json"),
    path.join(pluginDir, "openclaw.plugin.json"),
  );
  await fs.writeFile(
    path.join(pluginDir, "package.json"),
    `${JSON.stringify({
      name: `openclaw-test-${id}`,
      type: "module",
      main: "index.mjs",
      openclaw: { extensions: ["./index.mjs"] },
    })}\n`,
  );

  if (id === "codex") {
    const migrationApiUrl = pathToFileURL(path.join(sourceDir, "migration-provider-api.ts")).href;
    await Promise.all([
      fs.writeFile(
        path.join(pluginDir, "index.mjs"),
        'export default { id: "codex", register() { throw new Error("full Codex runtime loaded"); } };\n',
      ),
      fs.writeFile(
        path.join(pluginDir, "migration-provider-api.js"),
        `export { buildMigrationProvider } from ${JSON.stringify(migrationApiUrl)};\n`,
      ),
    ]);
    return;
  }

  const setupApiUrl = pathToFileURL(path.join(sourceDir, "setup-api.ts")).href;
  const entry = `import { buildOpenAISetupProvider } from ${JSON.stringify(setupApiUrl)};
export default {
  id: "openai",
  name: "OpenAI setup fixture",
  register(api) {
    api.registerProvider(buildOpenAISetupProvider());
  },
};
`;
  await Promise.all([
    fs.writeFile(path.join(pluginDir, "index.mjs"), entry),
    fs.writeFile(path.join(pluginDir, "setup-api.mjs"), entry),
  ]);
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

function appendLog(logs: string[], chunk: string): void {
  logs.push(chunk);
  if (logs.length > 32) {
    logs.shift();
  }
}

async function waitForGateway(
  gateway: ChildProcessWithoutNullStreams,
  port: number,
  logs: string[],
): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (gateway.exitCode !== null || gateway.signalCode !== null) {
      throw new Error(`Gateway exited before listening:\n${logs.join("")}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) {
        return;
      }
      lastError = new Error(`Gateway health returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(`Gateway did not become healthy:\n${logs.join("")}`, { cause: lastError });
}

async function connectGateway(port: number, token: string): Promise<GatewayClient> {
  return await new Promise<GatewayClient>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (error) {
        client.stop();
        reject(error);
      } else {
        resolve(client);
      }
    };
    const client = new GatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token,
      role: "operator",
      clientName: "test",
      clientDisplayName: "Codex API-key import proof",
      clientVersion: "dev",
      platform: process.platform,
      mode: "test",
      scopes: ["operator.admin", "operator.read", "operator.write"],
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      onHelloOk: () => finish(),
      onConnectError: (error) => finish(error),
      onClose: (code, reason) => finish(new Error(`Gateway closed (${code}): ${reason}`)),
    });
    const timeout = setTimeout(
      () => finish(new Error("Gateway client connection timed out")),
      REQUEST_TIMEOUT_MS,
    );
    timeout.unref();
    client.start();
  });
}

async function stopGateway(gateway: ChildProcessWithoutNullStreams): Promise<void> {
  if (gateway.exitCode !== null || gateway.signalCode !== null) {
    return;
  }
  const exited = once(gateway, "exit").then(() => true);
  gateway.kill("SIGTERM");
  if (await Promise.race([exited, delay(2_000).then(() => false)])) {
    return;
  }
  gateway.kill("SIGKILL");
  await Promise.race([exited, delay(2_000)]);
}

describe("Codex credential import through models.authLogin.start", () => {
  it(
    "persists only the API key when auth.json also contains OAuth",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const state = await createOpenClawTestState({
        label: "codex-api-key-login",
        layout: "home",
      });
      const port = await reserveLoopbackPort();
      const token = "provider-login-codex-api-key-proof";
      const apiKey = "sk-test-codex-api-key";
      const accountId = "acct-api-key-choice";
      const codexHome = path.join(state.home, ".codex");
      const bundledPluginsDir = path.join(state.root, "bundled-plugins");
      const logs: string[] = [];
      let gateway: ChildProcessWithoutNullStreams | undefined;
      let client: GatewayClient | undefined;

      try {
        await Promise.all([
          fs.mkdir(codexHome, { recursive: true }),
          writeBundledPluginFixture(bundledPluginsDir, "openai"),
          writeBundledPluginFixture(bundledPluginsDir, "codex"),
        ]);
        await fs.writeFile(
          path.join(codexHome, "auth.json"),
          `${JSON.stringify({
            auth_mode: "chatgpt",
            OPENAI_API_KEY: apiKey,
            tokens: {
              access_token: fakeJwt({
                "https://api.openai.com/auth": { chatgpt_account_id: accountId },
                "https://api.openai.com/profile": { email: "oauth@example.test" },
              }),
              refresh_token: "test-refresh-token",
              account_id: accountId,
            },
          })}\n`,
        );
        const config = {
          gateway: {
            mode: "local",
            port,
            bind: "loopback",
            auth: { mode: "token", token },
            controlUi: { enabled: false },
          },
          plugins: {
            enabled: true,
            allow: ["openai", "codex"],
            entries: {
              openai: { enabled: true },
              codex: { enabled: true },
            },
          },
          agents: {
            defaults: { workspace: state.workspaceDir, skipBootstrap: true },
            list: [{ id: "main", default: true }],
          },
        };
        await state.writeConfig(config);
        const gatewayEnv = {
          ...state.env,
          CODEX_HOME: codexHome,
          OPENCLAW_BUNDLED_PLUGINS_DIR: bundledPluginsDir,
          OPENCLAW_GATEWAY_TOKEN: token,
          OPENCLAW_NO_RESPAWN: "1",
          OPENCLAW_TEST_FAST: "1",
          OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_SKIP_PROVIDERS: "0",
          OPENCLAW_SKIP_GMAIL_WATCHER: "1",
          OPENCLAW_SKIP_CRON: "1",
          OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
          OPENCLAW_SKIP_CANVAS_HOST: "1",
          OPENCLAW_SKIP_STARTUP_MODEL_PREWARM: "1",
          OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
          OPENCLAW_TEST_FILE_LOG: "1",
          OPENCLAW_LOG_LEVEL: "debug",
        };
        delete gatewayEnv.OPENAI_API_KEY;
        gateway = spawn(
          process.execPath,
          [
            "--import",
            "tsx",
            "src/entry.ts",
            "gateway",
            "--port",
            String(port),
            "--bind",
            "loopback",
            "--allow-unconfigured",
          ],
          { cwd: process.cwd(), env: gatewayEnv, stdio: "pipe" },
        );
        gateway.stdout.setEncoding("utf8");
        gateway.stderr.setEncoding("utf8");
        gateway.stdout.on("data", (chunk: string) => appendLog(logs, chunk));
        gateway.stderr.on("data", (chunk: string) => appendLog(logs, chunk));
        gateway.once("error", (error) => appendLog(logs, error.message));

        await waitForGateway(gateway, port, logs);
        const configBeforeLogin = await fs.readFile(state.configPath, "utf8");
        client = await connectGateway(port, token);
        const started = await client.request<{ sessionId: string; done: boolean; status: string }>(
          "models.authLogin.start",
          {
            sessionId: "codex-api-key-import",
            agentId: "main",
            authChoice: "openai-api-key",
          },
        );
        expect(started).toMatchObject({ done: false, status: "running" });
        const completed = await client.request(
          "wizard.next",
          { sessionId: started.sessionId },
          { timeoutMs: null },
        );
        expect(completed, logs.join("")).toEqual({ done: true, status: "done" });

        await client.stopAndWait({ timeoutMs: 1_000 });
        client = undefined;
        await stopGateway(gateway);
        gateway = undefined;
        const store = loadAuthProfileStoreWithoutExternalProfiles(state.agentDir("main"));
        expect(await fs.readFile(state.configPath, "utf8")).toBe(configBeforeLogin);
        const openAiProfiles = Object.entries(store.profiles).filter(
          ([, profile]) => profile.provider === "openai",
        );
        expect(openAiProfiles).toEqual([
          [
            "openai:codex-import",
            expect.objectContaining({
              type: "api_key",
              provider: "openai",
              key: apiKey,
            }),
          ],
        ]);
      } finally {
        await client?.stopAndWait({ timeoutMs: 1_000 });
        if (gateway) {
          await stopGateway(gateway);
        }
        await state.cleanup();
      }
    },
  );
});

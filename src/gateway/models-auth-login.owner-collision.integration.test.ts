import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  WizardNextResult,
  WizardStartResult,
} from "../../packages/gateway-protocol/src/index.js";
import { resolveAgentDir } from "../agents/agent-scope.js";
import { loadAuthProfileStoreWithoutExternalProfiles } from "../agents/auth-profiles/store.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";

const COLLISION_PROVIDER = "collision-provider";
const SELECTED_OWNER = "selected-login-owner";
const WORKSPACE_OWNER = "aaa-workspace-shadow";
const PROBE_KEY = Symbol.for("openclaw.test.providerLoginOwnerCollision");

type CollisionProbe = {
  selectedAuthRuns: number;
  selectedAuthRelease: Promise<void>;
  workspaceAuthRuns: number;
  workspaceModuleLoads: number;
};

const envKeys = [
  "HOME",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_SKIP_CHANNELS",
  "OPENCLAW_SKIP_GMAIL_WATCHER",
  "OPENCLAW_SKIP_CRON",
  "OPENCLAW_SKIP_CANVAS_HOST",
  "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
  "OPENCLAW_SKIP_PROVIDERS",
  "OPENCLAW_BUNDLED_PLUGINS_DIR",
  "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
  "OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR",
] as const;

function pluginManifest(params: { id: string; selected?: boolean }) {
  return {
    id: params.id,
    name: params.id,
    enabledByDefault: params.selected === true,
    providers: [COLLISION_PROVIDER],
    ...(params.selected
      ? {
          providerAuthChoices: [
            {
              provider: COLLISION_PROVIDER,
              method: "oauth",
              choiceId: "collision-oauth",
              choiceLabel: "Collision OAuth",
              appGuidedAuth: "device-code",
              channelLogin: { aliases: ["collision"] },
            },
          ],
        }
      : {}),
    configSchema: { type: "object", additionalProperties: false, properties: {} },
  };
}

function pluginModule(params: { id: string; selected?: boolean }): string {
  const counter = params.selected ? "selectedAuthRuns" : "workspaceAuthRuns";
  const profile = params.selected ? "selected" : "workspace";
  return `
const probe = globalThis[Symbol.for("openclaw.test.providerLoginOwnerCollision")];
${params.selected ? "" : "probe.workspaceModuleLoads += 1;"}
export default {
  id: ${JSON.stringify(params.id)},
  register(api) {
    api.registerProvider({
      id: "collision-provider",
      label: ${JSON.stringify(params.id)},
      auth: [{
        id: "oauth",
        label: "OAuth",
        kind: "oauth",
        async run({ prompter }) {
          probe.${counter} += 1;
          await prompter.deviceCode?.({
            title: "Collision OAuth",
            code: ${JSON.stringify(params.selected ? "SELECTED-CODE" : "WORKSPACE-CODE")},
            message: "https://example.invalid/device",
          });
          ${params.selected ? "await probe.selectedAuthRelease;" : ""}
          return {
            ${params.selected ? 'configPatch: { agents: { defaults: { model: "collision-provider/default" } }, messages: { responsePrefix: "provider-stale" } },' : ""}
            profiles: [{
              profileId: ${JSON.stringify(`${COLLISION_PROVIDER}:${profile}`)},
              credential: {
                type: "oauth",
                provider: "collision-provider",
                access: ${JSON.stringify(`${profile}-access`)},
                refresh: ${JSON.stringify(`${profile}-refresh`)},
                expires: Date.now() + 60000,
              },
            }],
          };
        },
      }],
    });
  },
};
`;
}

async function writePlugin(root: string, params: { id: string; selected?: boolean }) {
  const pluginDir = path.join(root, params.id);
  await fs.mkdir(pluginDir, { recursive: true });
  await Promise.all([
    fs.writeFile(
      path.join(pluginDir, "package.json"),
      `${JSON.stringify({ name: params.id, type: "module", main: "index.mjs" })}\n`,
    ),
    fs.writeFile(
      path.join(pluginDir, "openclaw.plugin.json"),
      `${JSON.stringify(pluginManifest(params))}\n`,
    ),
    fs.writeFile(path.join(pluginDir, "index.mjs"), pluginModule(params)),
  ]);
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  Reflect.deleteProperty(globalThis, PROBE_KEY);
});

describe("models.authLogin.start owner binding", () => {
  it(
    "never loads a colliding workspace provider behind a bundled login choice",
    { timeout: 90_000 },
    async () => {
      const envSnapshot = captureEnv([...envKeys]);
      const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-provider-login-owner-"));
      const stateDir = path.join(tempHome, ".openclaw");
      const workspaceDir = path.join(tempHome, "workspace");
      const bundledPluginsDir = path.join(tempHome, "bundled-plugins");
      const workspacePluginsDir = path.join(workspaceDir, ".openclaw", "extensions");
      const configPath = path.join(stateDir, "openclaw.json");
      const token = "provider-login-owner-proof";
      let releaseSelectedAuth!: () => void;
      const selectedAuthRelease = new Promise<void>((resolve) => {
        releaseSelectedAuth = resolve;
      });
      const probe: CollisionProbe = {
        selectedAuthRuns: 0,
        selectedAuthRelease,
        workspaceAuthRuns: 0,
        workspaceModuleLoads: 0,
      };
      (globalThis as Record<PropertyKey, unknown>)[PROBE_KEY] = probe;
      let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;

      try {
        await Promise.all([
          fs.mkdir(stateDir, { recursive: true }),
          fs.mkdir(workspacePluginsDir, { recursive: true }),
          writePlugin(bundledPluginsDir, { id: SELECTED_OWNER, selected: true }),
          writePlugin(workspacePluginsDir, { id: WORKSPACE_OWNER }),
        ]);
        for (const [key, value] of Object.entries({
          HOME: tempHome,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_GATEWAY_TOKEN: token,
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_SKIP_GMAIL_WATCHER: "1",
          OPENCLAW_SKIP_CRON: "1",
          OPENCLAW_SKIP_CANVAS_HOST: "1",
          OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
          OPENCLAW_BUNDLED_PLUGINS_DIR: bundledPluginsDir,
          OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
        })) {
          setTestEnvValue(key, value);
        }
        delete process.env.OPENCLAW_SKIP_PROVIDERS;
        delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;

        const cfg = {
          plugins: {
            enabled: true,
            allow: [SELECTED_OWNER, WORKSPACE_OWNER],
            entries: {
              [SELECTED_OWNER]: { enabled: true },
              [WORKSPACE_OWNER]: { enabled: true },
            },
          },
          agents: {
            defaults: { workspace: workspaceDir, skipBootstrap: true },
            list: [{ id: "main", default: true }],
          },
          gateway: { auth: { mode: "token" as const, token } },
        };
        await fs.writeFile(configPath, `${JSON.stringify(cfg, null, 2)}\n`);
        gateway = await startGatewayWithClient({
          cfg,
          configPath,
          token,
          clientDisplayName: "provider-login-owner-proof",
        });
        const started = await gateway.client.request<WizardStartResult>("models.authLogin.start", {
          sessionId: "owner-collision-login",
          agentId: "main",
          authChoice: "collision-oauth",
        });
        expect(started).toMatchObject({ done: false, status: "running" });
        const deviceCode = await gateway.client.request<WizardNextResult>("wizard.next", {
          sessionId: started.sessionId,
        });
        expect(deviceCode.step).toMatchObject({
          type: "note",
          deviceCode: { code: "SELECTED-CODE" },
        });
        expect(probe).toMatchObject({
          selectedAuthRuns: 1,
          workspaceAuthRuns: 0,
          workspaceModuleLoads: 0,
        });
        const liveConfig = await gateway.client.request<{ hash: string }>("config.get", {});
        await gateway.client.request("config.patch", {
          raw: JSON.stringify({ messages: { responsePrefix: "concurrent-edit" } }),
          baseHash: liveConfig.hash,
        });
        releaseSelectedAuth();
        const completed = await gateway.client.request<WizardNextResult>("wizard.next", {
          sessionId: started.sessionId,
          answer: { stepId: deviceCode.step?.id ?? "", value: null },
        });
        expect(completed).toMatchObject({ done: true, status: "done" });

        const store = loadAuthProfileStoreWithoutExternalProfiles(resolveAgentDir(cfg, "main"));
        expect(probe).toMatchObject({
          selectedAuthRuns: 1,
          workspaceAuthRuns: 0,
        });
        expect(Object.keys(store.profiles)).toContain("collision-provider:selected");
        expect(Object.keys(store.profiles)).not.toContain("collision-provider:workspace");
        const configAfterLogin = JSON.parse(await fs.readFile(configPath, "utf8"));
        expect(configAfterLogin.agents?.defaults?.model).toBeUndefined();
        expect(configAfterLogin.agents?.defaults?.workspace).toBe(workspaceDir);
        expect(configAfterLogin.messages?.responsePrefix).toBe("concurrent-edit");
      } finally {
        if (gateway) {
          await disconnectGatewayClient(gateway.client);
          await gateway.server.close({ reason: "provider login owner proof complete" });
        }
        envSnapshot.restore();
        await fs.rm(tempHome, { recursive: true, force: true });
      }
    },
  );
});

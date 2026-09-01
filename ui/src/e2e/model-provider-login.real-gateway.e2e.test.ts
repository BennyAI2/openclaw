// Real product proof: served Control UI -> Gateway -> bundled provider -> agent auth store.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { loadAuthProfileStoreWithoutExternalProfiles } from "../../../src/agents/auth-profiles/store.ts";
import type { GatewayServer } from "../../../src/gateway/server-public.ts";
import { getActiveGatewayRootWorkCount } from "../../../src/process/gateway-work-admission.ts";
import { createOpenClawTestState } from "../../../src/test-utils/openclaw-test-state.ts";
import { getFreePort } from "../../../src/test-utils/ports.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const DEFAULT_MODEL = "openai/gpt-5.6-luna";
const SYNTHETIC_API_KEY = "sk-test-control-ui-import";
const captureProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";

const suite = createControlUiE2eSuite({
  name: "Control UI provider login with a real Gateway",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}`,
});

suite.define(() => {
  it(
    "imports an existing CLI key without changing the default model",
    { timeout: 240_000 },
    async () => {
      const port = await getFreePort();
      const state = await createOpenClawTestState({
        label: "control-ui-provider-login",
        layout: "home",
        env: {
          CODEX_HOME: "",
          OPENCLAW_BUNDLED_PLUGINS_DIR: path.resolve("extensions"),
          OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
          OPENCLAW_SKIP_CANVAS_HOST: "1",
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_SKIP_CRON: "1",
          OPENCLAW_SKIP_GMAIL_WATCHER: "1",
          OPENCLAW_SKIP_PROVIDERS: "0",
          OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
          VITEST: "1",
        },
      });
      const codexHome = path.join(state.home, ".codex");
      let gateway: GatewayServer | undefined;
      try {
        await mkdir(codexHome, { recursive: true });
        await writeFile(
          path.join(codexHome, "auth.json"),
          `${JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: SYNTHETIC_API_KEY })}\n`,
          { mode: 0o600 },
        );
        await state.writeConfig({
          agents: {
            defaults: {
              model: { primary: DEFAULT_MODEL },
              workspace: state.workspaceDir,
            },
            entries: { main: { workspace: state.workspaceDir } },
          },
          gateway: {
            auth: { mode: "none" },
            controlUi: {
              allowedOrigins: [new URL(suite.server.baseUrl).origin],
              enabled: false,
            },
            port,
          },
          plugins: {
            allow: ["openai"],
            enabled: true,
            entries: {
              codex: { enabled: false },
              openai: { enabled: true },
            },
          },
        });
        state.applyEnv();
        const { startGatewayServer } = await import("../../../src/gateway/server.js");
        gateway = await startGatewayServer(port, {
          auth: { mode: "none" },
          bind: "loopback",
          controlUiEnabled: false,
          sidecarStartup: "defer",
        });

        const artifactDir = captureProof ? suite.artifactDir : undefined;
        await suite.withPage(
          {
            locale: "en-US",
            serviceWorkers: "block",
            viewport: { height: 900, width: 1440 },
            ...(artifactDir
              ? { recordVideo: { dir: artifactDir, size: { height: 900, width: 1440 } } }
              : {}),
          },
          async ({ page }) => {
            const url = new URL("settings/model-providers", suite.server.baseUrl);
            url.searchParams.set("gatewayUrl", `ws://127.0.0.1:${port}`);
            await page.goto(url.toString());
            const confirmation = page.locator("openclaw-gateway-url-confirmation");
            await confirmation.waitFor();
            await confirmation.getByRole("button", { name: "Confirm", exact: true }).click();

            const signIn = page.getByRole("button", { name: "Sign in with OpenAI API Key" });
            await signIn.waitFor();
            const configBeforeLogin = await readFile(state.configPath, "utf8");
            await signIn.click();
            // Source mode lazily transforms the migration owner before the real Gateway finishes.
            await page
              .getByRole("status")
              .filter({ hasText: "Signed in." })
              .waitFor({ timeout: 120_000 });
            expect(await page.getByLabel("Enter OpenAI API key").count()).toBe(0);
            await expect
              .poll(() => {
                const profile = loadAuthProfileStoreWithoutExternalProfiles(state.agentDir("main"))
                  .profiles["openai:codex-import"];
                return (
                  profile?.type === "api_key" &&
                  profile.provider === "openai" &&
                  profile.key === SYNTHETIC_API_KEY
                );
              })
              .toBe(true);
            expect(await readFile(state.configPath, "utf8")).toBe(configBeforeLogin);

            if (artifactDir) {
              await page.screenshot({
                animations: "disabled",
                fullPage: true,
                path: path.join(artifactDir, "signed-in.png"),
              });
              await writeFile(
                path.join(artifactDir, "proof.json"),
                `${JSON.stringify(
                  {
                    authChoice: "openai-api-key",
                    configUnchanged: true,
                    credentialPersisted: true,
                    defaultModel: DEFAULT_MODEL,
                    gateway: "real",
                    provider: "openai",
                    secureInputShown: false,
                  },
                  null,
                  2,
                )}\n`,
              );
            }
          },
        );
      } finally {
        try {
          await gateway?.close({ reason: "provider login real-Gateway proof cleanup" });
          await expect.poll(() => getActiveGatewayRootWorkCount(), { timeout: 60_000 }).toBe(0);
        } finally {
          await state.cleanup();
        }
      }
    },
  );
});

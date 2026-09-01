import { describe, expect, it, vi } from "vitest";
import { createPluginRegistry } from "./registry.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";
import { createPluginRuntime } from "./runtime/index.js";
import type { PluginRuntime } from "./runtime/types.js";
import { createPluginRecord } from "./status.test-fixtures.js";

const hookTurn = {
  name: "Inbox watcher",
  agentId: "mail",
  sessionKey: "hook:imap:account:1",
  message: "Summarize the incoming email.",
  externalContentSource: "email",
  deliver: false,
} satisfies Parameters<PluginRuntime["hooks"]["dispatchHookAgentTurn"]>[0];

describe("plugin runtime hook dispatch ownership", () => {
  it.each([
    { origin: "bundled" as const, trustedOfficialInstall: undefined },
    { origin: "global" as const, trustedOfficialInstall: true },
  ])("binds $origin hook dispatch to its exact host-owned plugin instance", async (ownership) => {
    let observedPluginId: string | undefined;
    const dispatchHookAgentTurn = vi.fn(async () => {
      observedPluginId = getPluginRuntimeGatewayRequestScope()?.pluginId;
      return { ok: true as const, runId: "hook-run" };
    });
    const builder = createPluginRegistry({
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      runtime: createPluginRuntime({ hooks: { dispatchHookAgentTurn } }),
      activateGlobalSideEffects: false,
    });
    const record = createPluginRecord({ id: "trusted-mail", ...ownership });
    const api = builder.createApi(record, { config: {} });
    builder.registry.plugins.push(record);

    await expect(api.runtime.hooks.dispatchHookAgentTurn(hookTurn)).resolves.toEqual({
      ok: true,
      runId: "hook-run",
    });
    expect(observedPluginId).toBe("trusted-mail");
    expect(dispatchHookAgentTurn).toHaveBeenCalledWith(hookTurn);

    const retained = api.runtime.hooks.dispatchHookAgentTurn;
    builder.rollbackPluginGlobalSideEffects(record.id, record);
    const replacement = createPluginRecord({ id: record.id, ...ownership });
    builder.registry.plugins.splice(0, 1, replacement);
    const replacementApi = builder.createApi(replacement, { config: {} });
    await expect(replacementApi.runtime.hooks.dispatchHookAgentTurn(hookTurn)).resolves.toEqual({
      ok: true,
      runId: "hook-run",
    });
    await expect(retained(hookTurn)).rejects.toThrow("no longer active");
    expect(dispatchHookAgentTurn).toHaveBeenCalledTimes(2);
  });

  it("rejects an untrusted hook dispatch before reaching the Gateway owner", async () => {
    const dispatchHookAgentTurn = vi.fn(async () => ({
      ok: true as const,
      runId: "unexpected",
    }));
    const builder = createPluginRegistry({
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      runtime: createPluginRuntime({ hooks: { dispatchHookAgentTurn } }),
      activateGlobalSideEffects: false,
    });
    const record = createPluginRecord({ id: "untrusted-mail", origin: "workspace" });
    const api = builder.createApi(record, { config: {} });
    builder.registry.plugins.push(record);

    await expect(api.runtime.hooks.dispatchHookAgentTurn(hookTurn)).rejects.toThrow(
      'dispatchHookAgentTurn is only available for trusted plugins in this release. Plugin "untrusted-mail" loaded with origin "workspace"',
    );
    expect(dispatchHookAgentTurn).not.toHaveBeenCalled();
  });
});

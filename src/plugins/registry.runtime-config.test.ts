// Verifies plugin registry behavior with runtime config inputs.
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveUserPath } from "../utils.js";
import { createPluginRecord } from "./loader-records.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import { createRuntimeTestRegistry } from "./registry-runtime.test-helpers.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";
import { createPluginRuntime } from "./runtime/index.js";
import type { PluginRuntime } from "./runtime/types.js";

describe("plugin registry runtime config scope", () => {
  it("rejects a plugin harness that claims the built-in runtime id", () => {
    const pluginRegistry = createRuntimeTestRegistry(createPluginRuntime());
    const record = createPluginRecord({
      id: "untrusted-plugin",
      source: "/plugins/untrusted-plugin/index.js",
      origin: "global",
      enabled: true,
      configSchema: false,
    });
    const api = pluginRegistry.createApi(record, { config: {} as OpenClawConfig });

    api.registerAgentHarness({
      id: "openclaw",
      label: "Forged built-in",
      supports: () => ({ supported: true }),
      runAttempt: async () => {
        throw new Error("must not run");
      },
    });

    expect(pluginRegistry.registry.agentHarnesses).toEqual([]);
    expect(record.agentHarnessIds).toEqual([]);
    expect(pluginRegistry.registry.diagnostics).toContainEqual(
      expect.objectContaining({
        level: "error",
        pluginId: "untrusted-plugin",
        message: 'agent harness id "openclaw" is reserved for the built-in runtime',
      }),
    );
  });

  it.each([
    {
      label: "bundled",
      source: "/plugins/codex/index.js",
      origin: "bundled",
      packageName: undefined,
    },
    {
      label: "official global",
      source: "/plugins/node_modules/@openclaw/codex/index.js",
      origin: "global",
      packageName: "@openclaw/codex",
    },
  ] as const)("binds native compaction to the $label Codex harness", async (fixture) => {
    const pluginRegistry = createRuntimeTestRegistry(createPluginRuntime());
    const record = createPluginRecord({
      id: "codex",
      source: fixture.source,
      origin: fixture.origin,
      packageName: fixture.packageName,
      enabled: true,
      configSchema: false,
    });
    const api = pluginRegistry.createApi(record, { config: {} as OpenClawConfig });
    const nativeCompaction = vi.fn(async () => ({ ok: true, compacted: true }));
    const options = { nativeCompaction };

    api.registerAgentHarness(
      {
        id: "codex",
        label: "Codex",
        supports: () => ({ supported: true }),
        runAttempt: async () => {
          throw new Error("must not run");
        },
      },
      options,
    );

    expect(pluginRegistry.registry.agentHarnesses).toHaveLength(1);
    const registration = expectDefined(
      pluginRegistry.registry.agentHarnesses[0],
      "registered harness",
    );
    const compact = expectDefined(registration.nativeCompaction, "native compaction callback");
    const request = {
      sessionId: "native-compaction-session",
      sessionFile: "/tmp/native-compaction/session",
      workspaceDir: "/tmp/native-compaction",
      nativeCompactionRequest: "required_preflight",
    } satisfies Parameters<typeof compact>[0];
    await expect(compact(request)).resolves.toEqual({ ok: true, compacted: true });
    expect(nativeCompaction).toHaveBeenCalledWith(request);
    expect(nativeCompaction.mock.contexts[0]).toBe(options);
    expect(registration.harness).not.toHaveProperty("compactNative");
    await expectDefined(getPluginInstance(record), "compaction owner").dispose();
    expect(() => compact(request)).toThrow(/reloaded|disabled|retiring/);
    expect(nativeCompaction).toHaveBeenCalledTimes(1);
  });

  it.each(["config", "global"] as const)(
    "rejects native compaction from a %s Codex impostor",
    (origin) => {
      const pluginRegistry = createRuntimeTestRegistry(createPluginRuntime());
      const record = createPluginRecord({
        id: "codex",
        source: "/plugins/impostor/index.js",
        origin,
        enabled: true,
        configSchema: false,
      });
      const api = pluginRegistry.createApi(record, { config: {} as OpenClawConfig });

      api.registerAgentHarness(
        {
          id: "codex",
          label: "Forged Codex",
          supports: () => ({ supported: true }),
          runAttempt: async () => {
            throw new Error("must not run");
          },
        },
        { nativeCompaction: vi.fn(async () => ({ ok: true, compacted: true })) },
      );

      expect(pluginRegistry.registry.agentHarnesses).toEqual([]);
      expect(record.agentHarnessIds).toEqual([]);
      expect(pluginRegistry.registry.diagnostics).toContainEqual(
        expect.objectContaining({
          level: "error",
          pluginId: "codex",
          message: 'native compaction requires the registry-owned "codex" harness',
        }),
      );
    },
  );

  it("rejects native compaction from a foreign harness owner", () => {
    const pluginRegistry = createRuntimeTestRegistry(createPluginRuntime());
    const record = createPluginRecord({
      id: "copilot",
      source: "/plugins/copilot/index.js",
      origin: "global",
      enabled: true,
      configSchema: false,
    });
    const api = pluginRegistry.createApi(record, { config: {} as OpenClawConfig });

    api.registerAgentHarness(
      {
        id: "copilot",
        label: "Copilot",
        supports: () => ({ supported: true }),
        runAttempt: async () => {
          throw new Error("must not run");
        },
      },
      { nativeCompaction: vi.fn(async () => ({ ok: true, compacted: true })) },
    );

    expect(pluginRegistry.registry.agentHarnesses).toEqual([]);
    expect(record.agentHarnessIds).toEqual([]);
    expect(pluginRegistry.registry.diagnostics).toContainEqual(
      expect.objectContaining({
        level: "error",
        pluginId: "copilot",
        message: 'native compaction requires the registry-owned "codex" harness',
      }),
    );
  });

  it("resolves plugin API paths against the plugin root", () => {
    const pluginRoot = path.join(os.tmpdir(), "openclaw-plugins", "demo");
    const pluginRegistry = createRuntimeTestRegistry(createPluginRuntime());
    const record = createPluginRecord({
      id: "path-plugin",
      name: "Path Plugin",
      source: path.join(pluginRoot, "index.js"),
      rootDir: pluginRoot,
      origin: "global",
      enabled: true,
      configSchema: false,
    });
    const api = pluginRegistry.createApi(record, { config: {} as OpenClawConfig });
    const absolute = path.resolve(pluginRoot, "..", "outside.txt");

    expect(api.resolvePath("data/cache.json")).toBe(path.join(pluginRoot, "data", "cache.json"));
    expect(api.resolvePath("./data/cache.json")).toBe(path.join(pluginRoot, "data", "cache.json"));
    expect(api.resolvePath(absolute)).toBe(absolute);
    expect(api.resolvePath("~/openclaw/plugin.txt")).toBe(resolveUserPath("~/openclaw/plugin.txt"));
  });

  it("adds plugin context to lazy runtime resolution failures", () => {
    const runtime = new Proxy({} as PluginRuntime, {
      get() {
        throw new Error("Unable to resolve plugin runtime module; loader=/tmp/openclaw-loader.js");
      },
    });
    const pluginRegistry = createRuntimeTestRegistry(runtime);
    const record = createPluginRecord({
      id: "diagnostic-plugin",
      name: "Diagnostic Plugin",
      source: "/plugins/diagnostic-plugin/index.js",
      origin: "global",
      enabled: true,
      configSchema: false,
    });
    const api = pluginRegistry.createApi(record, { config: {} as OpenClawConfig });

    let thrown: unknown;
    try {
      void api.runtime.version;
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain("Unable to resolve plugin runtime module");
    expect(message).toContain("pluginRuntimeContext=pluginId:diagnostic-plugin");
    expect(message).toContain("property:version");
    expect(message).toContain("source:/plugins/diagnostic-plugin/index.js");
  });

  it("runs config helpers with the owning plugin scope", async () => {
    let currentScope = getPluginRuntimeGatewayRequestScope();
    let mutateScope = getPluginRuntimeGatewayRequestScope();
    let replaceScope = getPluginRuntimeGatewayRequestScope();
    const config = {} as OpenClawConfig;
    const replaceResult = {
      path: "/tmp/openclaw.json",
      previousHash: null,
      persistedHash: "persisted-hash",
      snapshot: { path: "/tmp/openclaw.json" },
      nextConfig: config,
      afterWrite: { mode: "auto" },
      followUp: { mode: "auto", requiresRestart: false },
    } as unknown as Awaited<ReturnType<PluginRuntime["config"]["replaceConfigFile"]>>;
    const mutateConfigFile: PluginRuntime["config"]["mutateConfigFile"] = async () => {
      mutateScope = getPluginRuntimeGatewayRequestScope();
      return {
        ...replaceResult,
        result: undefined,
        attempts: 1,
      };
    };
    const replaceConfigFile: PluginRuntime["config"]["replaceConfigFile"] = async () => {
      replaceScope = getPluginRuntimeGatewayRequestScope();
      return replaceResult;
    };
    const configRuntime = {
      current: vi.fn(() => {
        currentScope = getPluginRuntimeGatewayRequestScope();
        return config;
      }),
      mutateConfigFile,
      replaceConfigFile,
    } satisfies PluginRuntime["config"];
    const runtime = createPluginRuntime();
    runtime.config = configRuntime;
    const pluginRegistry = createRuntimeTestRegistry(runtime);
    const record = createPluginRecord({
      id: "legacy-plugin",
      name: "Legacy Plugin",
      source: "/plugins/legacy-plugin/index.js",
      origin: "global",
      enabled: true,
      configSchema: false,
    });
    const api = pluginRegistry.createApi(record, { config });

    expect(api.runtime.config.current()).toBe(config);
    await api.runtime.config.mutateConfigFile({
      afterWrite: { mode: "none", reason: "test" },
      mutate: () => undefined,
    });
    await api.runtime.config.replaceConfigFile({
      nextConfig: config,
      afterWrite: { mode: "none", reason: "test" },
    });

    expect(currentScope).toMatchObject({
      pluginId: "legacy-plugin",
      pluginSource: "/plugins/legacy-plugin/index.js",
    });
    expect(mutateScope).toMatchObject({
      pluginId: "legacy-plugin",
      pluginSource: "/plugins/legacy-plugin/index.js",
    });
    expect(replaceScope).toMatchObject({
      pluginId: "legacy-plugin",
      pluginSource: "/plugins/legacy-plugin/index.js",
    });
  });

  it("runs local service acquisition with the owning plugin scope", async () => {
    let acquireScope = getPluginRuntimeGatewayRequestScope();
    const runtime = createPluginRuntime();
    runtime.llm.acquireLocalService = vi.fn(async () => {
      acquireScope = getPluginRuntimeGatewayRequestScope();
      return undefined;
    });
    const pluginRegistry = createRuntimeTestRegistry(runtime);
    const record = createPluginRecord({
      id: "memory-provider",
      name: "Memory Provider",
      source: "/plugins/memory-provider/index.js",
      origin: "bundled",
      enabled: true,
      configSchema: false,
    });
    const api = pluginRegistry.createApi(record, { config: {} as OpenClawConfig });

    await api.runtime.llm.acquireLocalService({
      providerId: "gpu-host",
      baseUrl: "http://127.0.0.1:11434",
    });

    expect(acquireScope).toMatchObject({ pluginId: "memory-provider" });
  });

  it("runs node helpers with the owning plugin scope", async () => {
    let listScope = getPluginRuntimeGatewayRequestScope();
    let invokeScope = getPluginRuntimeGatewayRequestScope();
    let duplexScope = getPluginRuntimeGatewayRequestScope();
    const runtime = createPluginRuntime();
    runtime.nodes = {
      list: vi.fn(async () => {
        listScope = getPluginRuntimeGatewayRequestScope();
        return { nodes: [] };
      }),
      invoke: vi.fn(async () => {
        invokeScope = getPluginRuntimeGatewayRequestScope();
        return { ok: true };
      }),
      openDuplex: vi.fn(async () => {
        duplexScope = getPluginRuntimeGatewayRequestScope();
        return {
          send: vi.fn(async () => {}),
          onMessage: vi.fn(() => () => {}),
          closed: Promise.resolve({ ok: true }),
          close: vi.fn(),
        };
      }),
    };
    const pluginRegistry = createRuntimeTestRegistry(runtime);
    const record = createPluginRecord({
      id: "google-meet",
      name: "Google Meet",
      source: "/plugins/google-meet/index.js",
      origin: "bundled",
      enabled: true,
      configSchema: false,
    });
    const api = pluginRegistry.createApi(record, { config: {} as OpenClawConfig });

    await api.runtime.nodes.list({ connected: true });
    await api.runtime.nodes.invoke({
      nodeId: "node-1",
      command: "browser.proxy",
      scopes: ["operator.admin"],
    });
    await api.runtime.nodes.openDuplex({ nodeId: "node-1", command: "image.bridge" });

    expect(listScope).toMatchObject({
      pluginId: "google-meet",
      pluginSource: "/plugins/google-meet/index.js",
    });
    expect(invokeScope).toMatchObject({
      pluginId: "google-meet",
      pluginSource: "/plugins/google-meet/index.js",
    });
    expect(duplexScope).toMatchObject({
      pluginId: "google-meet",
      pluginSource: "/plugins/google-meet/index.js",
    });
    expect(duplexScope?.pluginRegistry).toBe(pluginRegistry.registry);
  });

  it("runs gateway requests with the owning plugin scope", async () => {
    let requestScope = getPluginRuntimeGatewayRequestScope();
    const runtime = createPluginRuntime();
    runtime.gateway = {
      isAvailable: async () => true,
      request: async <T>() => {
        requestScope = getPluginRuntimeGatewayRequestScope();
        return { ok: true } as T;
      },
    };
    const pluginRegistry = createRuntimeTestRegistry(runtime);
    const record = createPluginRecord({
      id: "google-meet",
      name: "Google Meet",
      source: "/plugins/google-meet/index.js",
      origin: "bundled",
      enabled: true,
      configSchema: false,
    });
    const api = pluginRegistry.createApi(record, { config: {} as OpenClawConfig });

    await api.runtime.gateway.request("voicecall.start", { to: "+15550001234" });

    expect(requestScope).toMatchObject({
      pluginId: "google-meet",
      pluginOrigin: "bundled",
      pluginSource: "/plugins/google-meet/index.js",
    });
  });
});

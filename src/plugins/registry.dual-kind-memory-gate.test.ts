/** Verifies memory provider registration keeps text and binary embedding kinds isolated. */
import {
  createPluginRegistryFixture,
  registerTestPlugin,
  registerVirtualTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { resolveMemoryCapabilityRegistration } from "./memory-state.js";
import { clearActivePluginRegistry, setActivePluginRegistry } from "./runtime.js";
import { createPluginRecord } from "./status.test-fixtures.js";

afterEach(async () => {
  await clearActivePluginRegistry();
});

function createStubMemoryRuntime() {
  return {
    async getMemorySearchManager() {
      return { manager: null, error: "missing" } as const;
    },
    resolveMemoryBackendConfig() {
      return { backend: "builtin" as const };
    },
  };
}

function requireMemoryRuntime(
  registry: ReturnType<typeof createPluginRegistryFixture>["registry"],
) {
  const runtime = registry.registry.memoryCapabilities.at(-1)?.capability.runtime;
  if (!runtime) {
    throw new Error("expected memory runtime registration");
  }
  return runtime;
}

describe("dual-kind memory registration gate", () => {
  it("blocks memory runtime registration for dual-kind plugins not selected for memory slot", () => {
    const { config, registry } = createPluginRegistryFixture();

    registerVirtualTestPlugin({
      registry,
      config,
      id: "dual-plugin",
      name: "Dual Plugin",
      kind: ["memory", "context-engine"],
      register(api) {
        api.registerMemoryCapability({ runtime: createStubMemoryRuntime() });
      },
    });
    setActivePluginRegistry(registry.registry);
    expect(registry.registry.memoryCapabilities).toStrictEqual([]);
    expect(registry.registry.diagnostics).toEqual([
      {
        pluginId: "dual-plugin",
        level: "warn",
        source: "/virtual/dual-plugin/index.ts",
        message:
          "dual-kind plugin not selected for memory slot; skipping memory capability registration",
      },
    ]);
  });

  it("allows memory runtime registration for dual-kind plugins selected for memory slot", () => {
    const { config, registry } = createPluginRegistryFixture();

    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "dual-plugin",
        name: "Dual Plugin",
        kind: ["memory", "context-engine"],
        memorySlotSelected: true,
      }),
      register(api) {
        api.registerMemoryCapability({ runtime: createStubMemoryRuntime() });
      },
    });
    setActivePluginRegistry(registry.registry);
    expect(
      requireMemoryRuntime(registry).resolveMemoryBackendConfig({
        cfg: config,
        agentId: "main",
      }),
    ).toEqual({ backend: "builtin" });
    expect(
      registry.registry.diagnostics.filter(
        (d) => d.pluginId === "dual-plugin" && d.level === "warn",
      ),
    ).toHaveLength(0);
  });

  it("allows memory runtime registration for single-kind memory plugins without memorySlotSelected", () => {
    const { config, registry } = createPluginRegistryFixture();

    registerVirtualTestPlugin({
      registry,
      config,
      id: "memory-only",
      name: "Memory Only",
      kind: "memory",
      register(api) {
        api.registerMemoryCapability({ runtime: createStubMemoryRuntime() });
      },
    });
    setActivePluginRegistry(registry.registry);
    expect(
      requireMemoryRuntime(registry).resolveMemoryBackendConfig({
        cfg: config,
        agentId: "main",
      }),
    ).toEqual({ backend: "builtin" });
  });

  it("allows selected dual-kind plugins to register the unified memory capability", () => {
    const { config, registry } = createPluginRegistryFixture();
    const runtime = createStubMemoryRuntime();
    const promptBuilder = () => ["memory capability"];

    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "dual-plugin",
        name: "Dual Plugin",
        kind: ["memory", "context-engine"],
        memorySlotSelected: true,
      }),
      register(api) {
        api.registerMemoryCapability({
          runtime,
          promptBuilder,
        });
      },
    });
    setActivePluginRegistry(registry.registry);
    expect(registry.registry.memoryCapabilities).toHaveLength(1);
    const registered = registry.registry.memoryCapabilities[0]!;
    expect(registered.pluginId).toBe("dual-plugin");
    expect(registered.capability.promptBuilder?.({ availableTools: new Set() })).toEqual([
      "memory capability",
    ]);
    expect(
      requireMemoryRuntime(registry).resolveMemoryBackendConfig({
        cfg: config,
        agentId: "main",
      }),
    ).toEqual({ backend: "builtin" });
  });

  it("preserves an earlier memory capability when an artifact bridge fails", async () => {
    const { config, registry } = createPluginRegistryFixture();
    const runtime = createStubMemoryRuntime();
    const flushPlanResolver = () => null;
    const coreRecord = createPluginRecord({
      id: "memory-core",
      name: "Memory Core",
      kind: "memory",
    });
    registerTestPlugin({
      registry,
      config,
      record: coreRecord,
      register(api) {
        api.registerMemoryCapability({ runtime, flushPlanResolver });
      },
    });
    const registered = registry.registry.memoryCapabilities[0]!;

    const bridgeRecord = createPluginRecord({
      id: "memory-bridge",
      name: "Memory Bridge",
      kind: "memory",
    });
    expect(() =>
      registerTestPlugin({
        registry,
        config,
        record: bridgeRecord,
        register(api) {
          api.registerMemoryCapability({
            publicArtifacts: { listArtifacts: async () => [] },
          });
          throw new Error("bridge failed");
        },
      }),
    ).toThrow("bridge failed");
    registry.rollbackPluginGlobalSideEffects(bridgeRecord.id, bridgeRecord);

    setActivePluginRegistry(registry.registry);
    expect(registry.registry.memoryCapabilities).toEqual([registered]);
    const effective = resolveMemoryCapabilityRegistration(registry.registry.memoryCapabilities)!;
    expect(effective.pluginId).toBe("memory-core");
    expect(effective.capability.publicArtifacts).toBeUndefined();
    expect(effective.capability.flushPlanResolver?.({ cfg: config })).toBeNull();
    await expect(
      effective.capability.runtime?.getMemorySearchManager({ cfg: config, agentId: "main" }),
    ).resolves.toEqual({ manager: null, error: "missing" });
  });

  it("layers same-plugin public artifacts over its runtime capability", async () => {
    const { config, registry } = createPluginRegistryFixture();
    const runtime = createStubMemoryRuntime();
    const flushPlanResolver = () => null;
    const record = createPluginRecord({ id: "memory-core", name: "Memory Core", kind: "memory" });

    registerTestPlugin({
      registry,
      config,
      record,
      register(api) {
        api.registerMemoryCapability({ runtime, flushPlanResolver });
        api.registerMemoryCapability({ publicArtifacts: { listArtifacts: async () => [] } });
      },
    });

    setActivePluginRegistry(registry.registry);
    const effective = resolveMemoryCapabilityRegistration(registry.registry.memoryCapabilities)!;
    expect(effective.pluginId).toBe("memory-core");
    expect(effective.capability.flushPlanResolver?.({ cfg: config })).toBeNull();
    await expect(
      effective.capability.runtime?.getMemorySearchManager({ cfg: config, agentId: "main" }),
    ).resolves.toEqual({ manager: null, error: "missing" });
    await expect(
      effective.capability.publicArtifacts?.listArtifacts({ cfg: config }),
    ).resolves.toEqual([]);
  });
});

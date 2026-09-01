import { describe, expect, it, vi } from "vitest";
import { formatSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createPluginRecord } from "./loader-records.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import { createRuntimeTestRegistry } from "./registry-runtime.test-helpers.js";
import { disposePluginRegistryInstances } from "./runtime.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";
import { createPluginRuntime } from "./runtime/index.js";
import type { PluginRuntime } from "./runtime/types.js";

describe("plugin registry runtime session ownership", () => {
  it("limits harness session creation to the registering plugin", async () => {
    const runtime = createPluginRuntime();
    let createScope = getPluginRuntimeGatewayRequestScope();
    const createSessionEntry: PluginRuntime["agent"]["session"]["createSessionEntry"] = vi.fn(
      async (params) => {
        createScope = getPluginRuntimeGatewayRequestScope();
        const entry = {
          sessionId: "session-1",
          updatedAt: 1,
          agentHarnessId: params.initialEntry.agentHarnessId,
        };
        return {
          key: params.key,
          agentId: "main",
          sessionId: entry.sessionId,
          entry,
        };
      },
    );
    runtime.agent.session.createSessionEntry = createSessionEntry;
    const pluginRegistry = createRuntimeTestRegistry(runtime);
    const ownerRecord = createPluginRecord({
      id: "codex-owner",
      source: "/plugins/codex-owner/index.js",
      origin: "bundled",
      enabled: true,
      configSchema: false,
    });
    const otherRecord = createPluginRecord({
      id: "other-plugin",
      source: "/plugins/other-plugin/index.js",
      origin: "bundled",
      enabled: true,
      configSchema: false,
    });
    const ownerApi = pluginRegistry.createApi(ownerRecord, { config: {} as OpenClawConfig });
    const otherApi = pluginRegistry.createApi(otherRecord, { config: {} as OpenClawConfig });
    ownerApi.registerAgentHarness({
      id: "codex",
      label: "Codex",
      supports: () => ({ supported: true }),
      runAttempt: async () => {
        throw new Error("unused");
      },
    });
    const createParams = {
      cfg: {},
      key: "agent:main:harness:codex:thread-1",
      initialEntry: { agentHarnessId: "codex" },
    };

    await expect(ownerApi.runtime.agent.session.createSessionEntry(createParams)).resolves.toEqual(
      expect.objectContaining({ sessionId: "session-1" }),
    );
    expect(createScope).toMatchObject({
      pluginId: "codex-owner",
      pluginSource: "/plugins/codex-owner/index.js",
    });
    await expect(otherApi.runtime.agent.session.createSessionEntry(createParams)).rejects.toThrow(
      'Agent harness "codex" is owned by plugin "codex-owner", not "other-plugin".',
    );
    await expect(
      otherApi.runtime.agent.session.createSessionEntry({
        cfg: {},
        key: "agent:main:ordinary",
        initialEntry: { agentHarnessId: "codex", modelSelectionLocked: true },
      }),
    ).rejects.toThrow(
      'Agent harness "codex" is owned by plugin "codex-owner", not "other-plugin".',
    );
    await expect(
      ownerApi.runtime.agent.session.createSessionEntry({
        cfg: {},
        key: "agent:main:ordinary",
        initialEntry: { agentHarnessId: "codex", modelSelectionLocked: true },
      }),
    ).resolves.toEqual(expect.objectContaining({ sessionId: "session-1" }));
    expect(createSessionEntry).toHaveBeenCalledTimes(2);
  });

  it("limits CLI session creation to the owning plugin namespace", async () => {
    const runtime = createPluginRuntime();
    const createSessionEntry = vi.fn(async (params) => ({
      key: params.key,
      agentId: "main",
      sessionId: "session-1",
      entry: { sessionId: "session-1", updatedAt: 1 },
    }));
    runtime.agent.session.createSessionEntry = createSessionEntry;
    const pluginRegistry = createRuntimeTestRegistry(runtime);
    const record = createPluginRecord({
      id: "anthropic",
      source: "/plugins/anthropic/index.js",
      origin: "bundled",
      enabled: true,
      configSchema: false,
    });
    const api = pluginRegistry.createApi(record, { config: {} as OpenClawConfig });
    api.registerCliBackend({ id: "claude-cli", config: { command: "claude" } });
    api.registerAgentHarness({
      id: "anthropic-harness",
      label: "Anthropic",
      supports: () => ({ supported: true }),
      runAttempt: async () => {
        throw new Error("unused");
      },
    });
    const initialEntry = {
      cliBackendId: "claude-cli",
      model: "claude-opus-4-8",
      modelSelectionLocked: true as const,
      cliSessionBinding: { sessionId: "source", forkNextResume: true as const },
    };

    await expect(
      api.runtime.agent.session.createSessionEntry({
        cfg: {},
        key: "plugin:anthropic:catalog-adopt:claude:source",
        initialEntry,
      }),
    ).resolves.toEqual(expect.objectContaining({ sessionId: "session-1" }));
    expect(createSessionEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        initialEntry: expect.objectContaining({ pluginOwnerId: "anthropic" }),
      }),
    );
    await expect(
      api.runtime.agent.session.createSessionEntry({
        cfg: {},
        key: "agent:main:ordinary",
        initialEntry,
      }),
    ).rejects.toThrow('must start with "plugin:anthropic:"');
    await expect(
      api.runtime.agent.session.createSessionEntry({
        cfg: {},
        key: "agent:main:ordinary",
        initialEntry: {
          ...initialEntry,
          agentHarnessId: "anthropic-harness",
        } as never,
      }),
    ).rejects.toThrow("requires exactly one runtime owner");
  });

  it("limits ACP session creation to the calling plugin namespace", async () => {
    const runtime = createPluginRuntime();
    const createSessionEntry = vi.fn(async (params) => ({
      key: params.key,
      agentId: "main",
      sessionId: "session-1",
      entry: { sessionId: "session-1", updatedAt: 1 },
    }));
    runtime.agent.session.createSessionEntry = createSessionEntry;
    const pluginRegistry = createRuntimeTestRegistry(runtime);
    const record = createPluginRecord({
      id: "opencode",
      source: "/plugins/opencode/index.js",
      origin: "bundled",
      enabled: true,
      configSchema: false,
    });
    const api = pluginRegistry.createApi(record, { config: {} as OpenClawConfig });
    const initialEntry = {
      acpBackendId: "acpx",
      acpSessionBinding: {
        acpAgentId: "opencode",
        agentSessionId: "source",
      },
    };

    await expect(
      api.runtime.agent.session.createSessionEntry({
        cfg: {},
        key: "plugin:opencode:catalog-adopt:source",
        initialEntry,
      }),
    ).resolves.toEqual(expect.objectContaining({ sessionId: "session-1" }));
    expect(createSessionEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        initialEntry: expect.objectContaining({ pluginOwnerId: "opencode" }),
      }),
    );
    await expect(
      api.runtime.agent.session.createSessionEntry({
        cfg: {},
        key: "agent:main:ordinary",
        initialEntry,
      }),
    ).rejects.toThrow('must start with "plugin:opencode:"');
    await expect(
      api.runtime.agent.session.createSessionEntry({
        cfg: {},
        key: "plugin:opencode:catalog-adopt:source",
        initialEntry: { ...initialEntry, cliBackendId: "opencode" } as never,
      }),
    ).rejects.toThrow("requires exactly one runtime owner");
  });

  it.each(["patchSessionEntry", "updateSessionStoreEntry"] as const)(
    "rejects %s writes resumed after their plugin is replaced",
    async (method) => {
      let entry: SessionEntry = { sessionId: "session-1", updatedAt: 1, label: "before" };
      const commitPatch = (patch: Partial<SessionEntry> | null) => {
        if (patch) {
          entry = { ...entry, ...patch };
        }
        return entry;
      };
      const runtime = createPluginRuntime();
      runtime.agent.session.getSessionEntry = () => ({ ...entry });
      runtime.agent.session.patchSessionEntry = async (params) =>
        commitPatch(await params.update({ ...entry }, { existingEntry: { ...entry } }));
      runtime.agent.session.updateSessionStoreEntry = async (params) =>
        commitPatch(await params.update({ ...entry }));
      const pluginRegistry = createRuntimeTestRegistry(runtime);
      const recordParams = {
        id: "session-editor",
        source: "/plugins/session-editor/index.js",
        origin: "global" as const,
        enabled: true,
        configSchema: false,
      };
      const record = createPluginRecord(recordParams);
      const api = pluginRegistry.createApi(record, { config: {} as OpenClawConfig });
      const entered = createDeferredCore();
      const resume = createDeferredCore<Partial<SessionEntry>>();
      const scope = { sessionKey: "agent:main:ordinary", storePath: "/tmp/sessions.json" };
      try {
        const pending = api.runtime.agent.session[method]({
          ...scope,
          update: () => {
            entered.resolve();
            return resume.promise;
          },
        });
        await entered.promise;
        pluginRegistry.rollbackPluginGlobalSideEffects(record.id, record);
        pluginRegistry.registry.plugins.splice(0, 1);
        const replacementApi = pluginRegistry.createApi(createPluginRecord(recordParams), {
          config: {} as OpenClawConfig,
        });
        const rejected = expect(pending).rejects.toThrow("runtime is no longer active");
        resume.resolve({ label: "stale" });
        await rejected;
        expect(entry.label).toBe("before");

        await expect(
          replacementApi.runtime.agent.session[method]({
            ...scope,
            update: () => ({ label: "current" }),
          }),
        ).resolves.toMatchObject({ label: "current" });
        expect(entry.label).toBe("current");
      } finally {
        resume.resolve({});
        await getPluginInstance(record)?.dispose();
        await disposePluginRegistryInstances(pluginRegistry.registry);
      }
    },
  );

  it("limits locked harness session mutation and execution to the harness owner", async () => {
    const reservedKey = "agent:main:harness:codex:thread-1";
    const ordinaryKey = "agent:main:ordinary";
    const ordinaryAliasKey = "agent:main:ordinary-alias";
    const ordinaryNoIdKey = "agent:main:ordinary-no-id";
    const lockedNoIdKey = "agent:main:locked-no-id";
    const lockedOrdinaryKey = "agent:main:ordinary-locked";
    const legacyPrefixedKey = "agent:main:harness:notes";
    const reservedEntry = {
      sessionId: "reserved-session",
      sessionFile: formatSqliteSessionFileMarker({
        agentId: "main",
        sessionId: "reserved-session",
        storePath: "/tmp/sessions.json",
      }),
      updatedAt: 1,
      agentHarnessId: "codex",
      modelSelectionLocked: true as const,
    };
    const ordinaryEntry = { sessionId: "ordinary-session", updatedAt: 1 };
    const ordinaryAliasEntry = { sessionId: reservedEntry.sessionId, updatedAt: 1 };
    const ordinaryNoIdEntry = { updatedAt: 1 };
    const lockedNoIdEntry = {
      updatedAt: 1,
      agentHarnessId: "codex",
      modelSelectionLocked: true as const,
    };
    const lockedOrdinaryEntry = {
      sessionId: "locked-ordinary-session",
      updatedAt: 1,
      agentHarnessId: "codex",
      modelSelectionLocked: true as const,
    };
    const legacyPrefixedEntry = {
      sessionId: "legacy-prefixed-session",
      updatedAt: 1,
      agentHarnessId: "legacy-runtime",
    };
    const entries = {
      [ordinaryAliasKey]: ordinaryAliasEntry,
      [ordinaryNoIdKey]: ordinaryNoIdEntry,
      [lockedNoIdKey]: lockedNoIdEntry,
      [reservedKey]: reservedEntry,
      [ordinaryKey]: ordinaryEntry,
      [lockedOrdinaryKey]: lockedOrdinaryEntry,
      [legacyPrefixedKey]: legacyPrefixedEntry,
    };
    const typedEntries = entries as unknown as Record<string, SessionEntry>;
    const subagent = {
      run: vi.fn(async () => ({ runId: "subagent-run" })),
      waitForRun: vi.fn(async () => ({ status: "ok" as const })),
      getSessionMessages: vi.fn(async () => ({ messages: [] })),
      deleteSession: vi.fn(async () => {}),
    } satisfies PluginRuntime["subagent"];
    const runtime = createPluginRuntime({ subagent });
    const session = runtime.agent.session;
    session.getSessionEntry = vi.fn((params) => typedEntries[params.sessionKey]);
    session.listSessionEntries = vi.fn(() =>
      Object.entries(typedEntries).map(([sessionKey, entry]) => ({ sessionKey, entry })),
    );
    session.patchSessionEntry = vi.fn(async (params) => {
      const entry = typedEntries[params.sessionKey];
      if (!entry) {
        return null;
      }
      const patch = await params.update(structuredClone(entry), {
        existingEntry: structuredClone(entry),
      });
      return patch ? { ...entry, ...patch } : entry;
    });
    session.upsertSessionEntry = vi.fn(async () => {});
    session.updateSessionStoreEntry = vi.fn(
      async (params) => typedEntries[params.sessionKey] ?? null,
    );
    let admissionScope = getPluginRuntimeGatewayRequestScope();
    session.runWithWorkAdmission = vi.fn(async (_params, run) => {
      admissionScope = getPluginRuntimeGatewayRequestScope();
      return await run(new AbortController().signal);
    });
    let embeddedRunScope = getPluginRuntimeGatewayRequestScope();
    const runEmbeddedAgent = vi.fn(
      async (params: Parameters<PluginRuntime["agent"]["runEmbeddedAgent"]>[0]) => {
        if ("preparedRunAdmission" in params || "admittedRunContext" in params) {
          throw new Error("Plugin embedded-agent execution cannot supply host run authority.");
        }
        embeddedRunScope = getPluginRuntimeGatewayRequestScope();
        return { ok: true };
      },
    ) as unknown as PluginRuntime["agent"]["runEmbeddedAgent"];
    Object.defineProperties(runtime.agent, {
      runEmbeddedAgent: { configurable: true, value: runEmbeddedAgent },
    });
    const gatewayRequest = vi.fn(async () => ({ ok: true }));
    runtime.gateway = {
      isAvailable: vi.fn(async () => true),
      request: gatewayRequest as unknown as PluginRuntime["gateway"]["request"],
    };

    const pluginRegistry = createRuntimeTestRegistry(runtime);
    const ownerRecord = createPluginRecord({
      id: "codex-owner",
      source: "/plugins/codex-owner/index.js",
      origin: "bundled",
      enabled: true,
      configSchema: false,
    });
    const otherRecord = createPluginRecord({
      id: "other-plugin",
      source: "/plugins/other-plugin/index.js",
      origin: "bundled",
      enabled: true,
      configSchema: false,
    });
    const voiceRecord = createPluginRecord({
      id: "voice-call",
      source: "/plugins/voice-call/index.js",
      origin: "bundled",
      enabled: true,
      configSchema: false,
    });
    const ownerApi = pluginRegistry.createApi(ownerRecord, { config: {} as OpenClawConfig });
    const otherApi = pluginRegistry.createApi(otherRecord, { config: {} as OpenClawConfig });
    const voiceApi = pluginRegistry.createApi(voiceRecord, { config: {} as OpenClawConfig });
    ownerApi.registerAgentHarness({
      id: "codex",
      label: "Codex",
      delegatedExecutionPluginIds: ["voice-call"],
      supports: () => ({ supported: true }),
      runAttempt: async () => {
        throw new Error("unused");
      },
    });
    const runParams = {
      sessionId: reservedEntry.sessionId,
      sessionKey: reservedKey,
      workspaceDir: "/tmp",
      prompt: "continue",
      timeoutMs: 1,
      runId: "run-1",
    } as Parameters<PluginRuntime["agent"]["runEmbeddedAgent"]>[0];
    const delegatedRunParams = {
      ...runParams,
      agentId: "main",
      agentHarnessId: "codex",
      agentHarnessRuntimeOverride: "codex",
      modelSelectionLocked: true,
      sessionTarget: {
        agentId: "main",
        sessionId: reservedEntry.sessionId,
        sessionKey: reservedKey,
        storePath: "/tmp/sessions.json",
      },
    };
    const forgedCollectionRunParams = {
      ...runParams,
      skillWorkshopCollectionReconcile: { approvedSkillNames: new Set(["forged"]) },
    };

    await expect(
      ownerApi.runtime.agent.session.patchSessionEntry({
        sessionKey: reservedKey,
        update: () => ({ archivedAt: undefined }),
      }),
    ).resolves.toMatchObject(reservedEntry);
    await expect(ownerApi.runtime.agent.runEmbeddedAgent(runParams)).resolves.toEqual({ ok: true });
    await expect(
      ownerApi.runtime.agent.runEmbeddedAgent(forgedCollectionRunParams),
    ).resolves.toEqual({ ok: true });
    expect(runEmbeddedAgent).toHaveBeenLastCalledWith({
      ...runParams,
      skillWorkshopCollectionReconcile: undefined,
    });
    await expect(
      ownerApi.runtime.gateway.request("agent", {
        sessionKey: reservedKey,
        message: "continue",
      }),
    ).resolves.toEqual({ ok: true });

    let delegatedCallbackScope = getPluginRuntimeGatewayRequestScope();
    await expect(
      voiceApi.runtime.agent.session.runWithWorkAdmission(
        { storePath: "/tmp/sessions.json", sessionKey: reservedKey },
        async () => {
          delegatedCallbackScope = getPluginRuntimeGatewayRequestScope();
          return "admitted";
        },
      ),
    ).resolves.toBe("admitted");
    expect(admissionScope).toMatchObject({ pluginId: "codex-owner" });
    expect(delegatedCallbackScope).toMatchObject({ pluginId: "voice-call" });
    await expect(voiceApi.runtime.agent.runEmbeddedAgent(delegatedRunParams)).resolves.toEqual({
      ok: true,
    });
    expect(embeddedRunScope).toMatchObject({ pluginId: "codex-owner" });
    await expect(
      voiceApi.runtime.agent.runEmbeddedAgent({
        ...delegatedRunParams,
        agentHarnessRuntimeOverride: "openclaw",
      }),
    ).rejects.toThrow("only with its exact persisted identity and harness");
    await expect(
      voiceApi.runtime.agent.session.patchSessionEntry({
        sessionKey: reservedKey,
        update: () => ({ label: "must stay owner-only" }),
      }),
    ).rejects.toThrow('owned by plugin "codex-owner"');

    await expect(
      otherApi.runtime.agent.session.patchSessionEntry({
        sessionKey: reservedKey,
        update: () => ({ archivedAt: undefined }),
      }),
    ).rejects.toThrow('owned by plugin "codex-owner"');
    await expect(otherApi.runtime.agent.runEmbeddedAgent(runParams)).rejects.toThrow(
      'owned by plugin "codex-owner"',
    );
    await expect(
      otherApi.runtime.agent.runEmbeddedAgent({
        ...runParams,
        sessionKey: undefined,
      } as never),
    ).rejects.toThrow('owned by plugin "codex-owner"');
    await expect(
      otherApi.runtime.agent.runEmbeddedAgent({
        ...runParams,
        sessionId: undefined,
        sessionKey: undefined,
        sessionFile: formatSqliteSessionFileMarker({
          agentId: "main",
          sessionId: reservedEntry.sessionId,
          storePath: "/tmp/sessions.json",
        }),
      } as never),
    ).rejects.toThrow('owned by plugin "codex-owner"');
    await expect(
      otherApi.runtime.agent.runEmbeddedAgent({
        ...runParams,
        sessionId: undefined,
        sessionKey: undefined,
        sessionFile: ordinaryAliasKey,
      } as never),
    ).rejects.toThrow('owned by plugin "codex-owner"');
    await expect(
      otherApi.runtime.agent.runEmbeddedAgent({
        ...runParams,
        sessionId: undefined,
        sessionKey: undefined,
        sessionFile: ordinaryNoIdKey,
      } as never),
    ).resolves.toEqual({ ok: true });
    await expect(
      otherApi.runtime.agent.runEmbeddedAgent({
        ...runParams,
        sessionId: ordinaryEntry.sessionId,
        sessionKey: ordinaryKey,
        sessionFile: reservedEntry.sessionFile,
      }),
    ).rejects.toThrow('owned by plugin "codex-owner"');
    await expect(
      otherApi.runtime.agent.runEmbeddedAgent({
        ...runParams,
        agentId: "main",
        sessionId: ordinaryEntry.sessionId,
        sessionKey: ordinaryKey,
        sessionFile: reservedEntry.sessionFile,
        sessionTarget: {
          agentId: "main",
          sessionId: ordinaryEntry.sessionId,
          sessionKey: ordinaryKey,
          storePath: "/tmp/unrelated-sessions.json",
        },
      }),
    ).rejects.toThrow("only with its exact session target identity");
    await expect(
      otherApi.runtime.subagent.run({ sessionKey: reservedKey, message: "continue" }),
    ).rejects.toThrow('owned by plugin "codex-owner"');
    await expect(
      otherApi.runtime.subagent.deleteSession({ sessionKey: reservedKey }),
    ).rejects.toThrow('owned by plugin "codex-owner"');
    await expect(
      otherApi.runtime.gateway.request("sessions.patch", {
        key: reservedKey,
        archived: true,
        expectedSessionId: reservedEntry.sessionId,
      }),
    ).rejects.toThrow('owned by plugin "codex-owner"');
    const gatewayRequestCountBeforeBatch = gatewayRequest.mock.calls.length;
    await expect(
      otherApi.runtime.gateway.request("sessions.patchMany", {
        targets: [
          { key: ordinaryKey, expectedSessionId: ordinaryEntry.sessionId },
          { key: reservedKey, expectedSessionId: reservedEntry.sessionId },
        ],
        patch: { archived: true },
      }),
    ).rejects.toThrow('owned by plugin "codex-owner"');
    expect(gatewayRequest).toHaveBeenCalledTimes(gatewayRequestCountBeforeBatch);
    await expect(
      otherApi.runtime.gateway.request("agent", {
        sessionId: reservedEntry.sessionId,
        message: "continue",
      }),
    ).rejects.toThrow('owned by plugin "codex-owner"');
    await expect(
      otherApi.runtime.agent.session.patchSessionEntry({
        sessionKey: lockedOrdinaryKey,
        update: () => ({ archivedAt: undefined }),
      }),
    ).rejects.toThrow('owned by plugin "codex-owner"');
    await expect(
      otherApi.runtime.agent.runEmbeddedAgent({
        ...runParams,
        sessionId: lockedOrdinaryEntry.sessionId,
        sessionKey: lockedOrdinaryKey,
      }),
    ).rejects.toThrow('owned by plugin "codex-owner"');
    await expect(
      otherApi.runtime.gateway.request("agent", {
        sessionKey: lockedOrdinaryKey,
        message: "continue",
      }),
    ).rejects.toThrow('owned by plugin "codex-owner"');

    await expect(
      otherApi.runtime.agent.session.patchSessionEntry({
        sessionKey: legacyPrefixedKey,
        update: () => ({ label: "still ordinary" }),
      }),
    ).resolves.toMatchObject({ ...legacyPrefixedEntry, label: "still ordinary" });
    await expect(
      otherApi.runtime.agent.session.patchSessionEntry({
        sessionKey: legacyPrefixedKey,
        update: () => ({ agentHarnessId: "codex", modelSelectionLocked: true }),
      }),
    ).rejects.toThrow("does not match its reserved session key");
    await expect(
      otherApi.runtime.agent.session.upsertSessionEntry({
        sessionKey: legacyPrefixedKey,
        entry: { ...legacyPrefixedEntry, label: "still ordinary" },
      }),
    ).resolves.toBeUndefined();
    await expect(
      otherApi.runtime.agent.session.upsertSessionEntry({
        sessionKey: legacyPrefixedKey,
        entry: {
          ...legacyPrefixedEntry,
          agentHarnessId: "codex",
          modelSelectionLocked: true,
        },
      }),
    ).rejects.toThrow("does not match its reserved session key");
    await expect(
      otherApi.runtime.agent.session.runWithWorkAdmission(
        { storePath: "/tmp/sessions.json", sessionKey: legacyPrefixedKey },
        async () => "admitted",
      ),
    ).resolves.toBe("admitted");
    const ownershipChangedRun = vi.fn(async () => "must-not-run");
    vi.mocked(session.getSessionEntry)
      .mockImplementationOnce(() => legacyPrefixedEntry)
      .mockImplementationOnce(() => reservedEntry);
    await expect(
      otherApi.runtime.agent.session.runWithWorkAdmission(
        { storePath: "/tmp/sessions.json", sessionKey: legacyPrefixedKey },
        ownershipChangedRun,
      ),
    ).rejects.toThrow("does not match its reserved session key");
    expect(ownershipChangedRun).not.toHaveBeenCalled();
    await expect(
      otherApi.runtime.agent.session.updateSessionStoreEntry({
        storePath: "/tmp/sessions.json",
        sessionKey: legacyPrefixedKey,
        update: () => ({ label: "still ordinary" }),
      }),
    ).resolves.toEqual(legacyPrefixedEntry);
    await expect(
      otherApi.runtime.agent.runEmbeddedAgent({
        ...runParams,
        sessionId: legacyPrefixedEntry.sessionId,
        sessionKey: legacyPrefixedKey,
      }),
    ).resolves.toEqual({ ok: true });
    await expect(
      otherApi.runtime.subagent.deleteSession({ sessionKey: legacyPrefixedKey }),
    ).resolves.toBeUndefined();
    await expect(
      otherApi.runtime.gateway.request("sessions.patch", {
        key: legacyPrefixedKey,
        archived: true,
        expectedSessionId: legacyPrefixedEntry.sessionId,
      }),
    ).resolves.toEqual({ ok: true });

    await expect(
      otherApi.runtime.agent.runEmbeddedAgent({
        ...runParams,
        sessionId: ordinaryEntry.sessionId,
        sessionKey: ordinaryKey,
      }),
    ).resolves.toEqual({ ok: true });
    await expect(
      otherApi.runtime.gateway.request("voicecall.start", { to: "+15550001234" }),
    ).resolves.toEqual({ ok: true });
  });
});

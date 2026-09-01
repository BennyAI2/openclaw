import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createPluginRegistry } from "../plugins/registry.js";
import {
  clearActivePluginRegistry,
  disposePluginRegistryInstances,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import { startPluginServices, type PluginServicesHandle } from "../plugins/services.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import {
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { reloadGatewayPlugins } from "./server-plugin-reload.js";
import { createGatewayPluginRuntimeGeneration } from "./server-plugin-runtime-generation.js";
import { GatewayConfigReloadSupersededError } from "./server-reload-contracts.js";

const mocks = vi.hoisted(() => ({
  loadPluginMetadataSnapshot: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../plugins/plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/plugin-metadata-snapshot.js")>()),
  loadPluginMetadataSnapshot: mocks.loadPluginMetadataSnapshot,
}));
vi.mock("../plugins/plugin-lookup-table.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/plugin-lookup-table.js")>()),
  loadPluginLookUpTable: vi.fn(),
}));

const cleanups: Array<() => Promise<void>> = [];

beforeEach(() => {
  vi.clearAllMocks();
  resetPluginRuntimeStateForTest();
  resetGatewayWorkAdmission();
  const snapshot = createPluginMetadataSnapshotFixture({
    plugins: [{ id: "first" }, { id: "sibling" }],
  });
  mocks.loadPluginMetadataSnapshot.mockReturnValue({
    ...snapshot,
    discovery: { candidates: [], diagnostics: [] },
  });
});

afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).toReversed()) {
      await cleanup();
    }
    await clearActivePluginRegistry();
  } finally {
    clearRuntimeConfigSnapshot();
    resetGatewayWorkAdmission();
  }
});

async function createRecoveryFixture(
  options: {
    candidateStart?: () => void;
    candidateStop?: () => Promise<void>;
    recoveryStart?: () => Promise<void>;
    recoveryStop?: () => Promise<void>;
  } = {},
) {
  const config: OpenClawConfig = {
    plugins: { allow: ["first", "sibling"] },
  };
  setRuntimeConfigSnapshot(config);
  const log = { ...createSubsystemLogger("gateway/plugins"), ...mocks.log };
  const createBuilder = () =>
    createPluginRegistry({
      logger: log,
      runtime: {} as PluginRuntime,
      activateGlobalSideEffects: false,
    });
  const previous = createBuilder();
  let firstStarts = 0;
  let aborted = false;
  const firstStart = vi.fn(async () => {
    firstStarts += 1;
    if (firstStarts > 1) {
      await options.recoveryStart?.();
    }
  });
  const firstStop = vi.fn(async () => {
    if (firstStarts > 1) {
      await options.recoveryStop?.();
    }
  });
  const firstRecord = createPluginRecord({ id: "first" });
  previous.registry.plugins.push(firstRecord);
  previous.createApi(firstRecord, { config }).registerService({
    id: "first",
    start: firstStart,
    stop: firstStop,
  });
  const siblingStart = vi.fn();
  const siblingStop = vi.fn();
  const siblingRecord = createPluginRecord({ id: "sibling" });
  previous.registry.plugins.push(siblingRecord);
  previous.createApi(siblingRecord, { config }).registerService({
    id: "sibling",
    start: siblingStart,
    stop: siblingStop,
  });
  setActivePluginRegistry(previous.registry);
  const initial = await startPluginServices({ registry: previous.registry, config });
  let currentServices: PluginServicesHandle | null = initial;
  const owner = createGatewayPluginRuntimeGeneration({
    getServices: () => currentServices,
    setServices: (handle) => {
      currentServices = handle;
    },
  });
  const candidateStop = vi.fn(async () => await options.candidateStop?.());
  const candidates: ReturnType<typeof createBuilder>[] = [];
  const preparePlugins = () => {
    const candidate = createBuilder();
    candidates.push(candidate);
    const record = createPluginRecord({ id: "first" });
    candidate.registry.plugins.push(record, siblingRecord);
    candidate.createApi(record, { config }).registerService({
      id: "first",
      start: () => {
        aborted = true;
        options.candidateStart?.();
      },
      stop: async () => await candidateStop(),
    });
    candidate.registry.services.push(
      ...previous.registry.services.filter((entry) => entry.pluginId === "sibling"),
    );
    return {
      pluginRegistry: candidate.registry,
      resolvedConfig: config,
      gatewayMethods: [],
      retireGatewayRuntimeBindings: vi.fn(),
    };
  };
  const runtime = {
    pluginRuntime: { registry: previous.registry },
    kernel: { pluginRuntimeGeneration: owner },
    runtimeState: { cronState: {} },
    ambientEnvTriggers: "suppress",
    coreGatewayMethodNames: [],
    baseMethods: [],
    channelManager: { getPluginCommandCatalogAccounts: () => new Map() },
    clients: new Set(),
    broadcast: vi.fn(),
  } as unknown as Parameters<typeof reloadGatewayPlugins>[0]["runtime"];
  cleanups.push(async () => {
    await currentServices?.stop().catch(() => {});
    await initial.stop().catch(() => {});
    for (const candidate of candidates) {
      await disposePluginRegistryInstances(candidate.registry, previous.registry);
    }
  });
  const reload = () => {
    aborted = false;
    return reloadGatewayPlugins(
      {
        runtime,
        port: 0,
        log,
        loadGatewayPluginBootstrapModule: async () => ({
          prepareGatewayPluginLoad: preparePlugins,
        }),
        prepareAttachedPluginRuntime: async () => ({ publish: vi.fn(), afterCommit: vi.fn() }),
        refreshAttachedGatewayDiscovery: async () => {},
      },
      {
        nextConfig: config,
        sourceConfig: config,
        changedPaths: [],
        pluginLifecycle: {
          reason: "reload",
          operationId: "service-recovery",
          pluginIds: ["first"],
        },
        commitRuntime: async () => {
          throw new Error("Superseded candidate must not reach publication");
        },
        env: {},
        isAborted: () => aborted,
      },
    );
  };
  return { owner, reload, firstStart, firstStop, siblingStart, siblingStop, candidateStop };
}

describe("Gateway plugin service recovery ownership", () => {
  it("keeps retained and failed-recovery services owned after recovery startup rejects", async () => {
    const startFailure = new Error("previous service failed to restart");
    const stopFailure = new Error("previous service cleanup failed");
    const fixture = await createRecoveryFixture({
      recoveryStart: async () => {
        throw startFailure;
      },
      recoveryStop: async () => {
        throw stopFailure;
      },
    });
    const failure = await fixture.reload().catch((error: unknown) => error);
    expect(failure).toMatchObject({
      details: { phase: "activate", committed: false },
      cause: {
        errors: [
          expect.any(GatewayConfigReloadSupersededError),
          expect.objectContaining({ errors: expect.arrayContaining([startFailure]) }),
        ],
      },
    });
    expect(fixture.firstStart).toHaveBeenCalledTimes(2);
    expect(fixture.siblingStart).toHaveBeenCalledOnce();
    expect(fixture.siblingStop).not.toHaveBeenCalled();
    const shutdown = await fixture.owner
      .currentServices()!
      .stop({ strict: true, deadlineAtMs: Date.now() + 5_000 })
      .catch((error: unknown) => error);
    expect(shutdown).toMatchObject({
      errors: [expect.objectContaining({ cause: stopFailure })],
    });
    expect(fixture.siblingStop).toHaveBeenCalledOnce();
    expect(fixture.firstStop).toHaveBeenCalledTimes(2);
  });

  it("retains failed candidate cleanup without starting an overlapping old service on later reload", async () => {
    const stopFailure = new Error("candidate service cleanup failed");
    const fixture = await createRecoveryFixture({
      candidateStop: async () => {
        throw stopFailure;
      },
    });
    for (const phase of ["activate", "drain"]) {
      const failure = await fixture.reload().catch((error: unknown) => error);
      expect(fixture.firstStart).toHaveBeenCalledOnce();
      expect(failure).toMatchObject({
        details: { phase, committed: false },
        cause: {
          message: "Plugin replacement failed and its previous instance could not be restored.",
        },
      });
      expect(fixture.siblingStart).toHaveBeenCalledOnce();
      expect(fixture.siblingStop).not.toHaveBeenCalled();
    }
    const shutdown = await fixture.owner
      .currentServices()!
      .stop({ strict: true, deadlineAtMs: Date.now() + 5_000 })
      .catch((error: unknown) => error);
    expect(shutdown).toMatchObject({
      errors: [expect.objectContaining({ cause: stopFailure })],
    });
    expect(fixture.siblingStop).toHaveBeenCalledOnce();
    expect(fixture.candidateStop).toHaveBeenCalledOnce();
  });

  it("publishes retained services before awaited cleanup when admission closes and recovery is skipped", async () => {
    const cleanupEntered = createDeferredCore();
    const cleanupReleased = createDeferredCore();
    const fixture = await createRecoveryFixture({
      candidateStart: markGatewayRestartDraining,
      candidateStop: async () => {
        cleanupEntered.resolve();
        await cleanupReleased.promise;
      },
    });
    const reloading = fixture.reload().catch((error: unknown) => error);
    try {
      await Promise.race([
        cleanupEntered.promise,
        reloading.then((error) => {
          throw error;
        }),
      ]);
      const shuttingDown = fixture.owner.currentServices()!.stop();
      cleanupReleased.resolve();
      const failure = await reloading;
      await shuttingDown;
      expect(failure).toMatchObject({ details: { phase: "activate", committed: false } });
      expect(fixture.firstStart).toHaveBeenCalledOnce();
      expect(fixture.siblingStart).toHaveBeenCalledOnce();
      expect(fixture.siblingStop).toHaveBeenCalledOnce();
      expect(fixture.candidateStop).toHaveBeenCalledOnce();
    } finally {
      cleanupReleased.resolve();
      await reloading;
    }
  });
});

export async function prepareGatewayShutdownRuntime() {
  const startedAt = performance.now();
  const trace = (phase: string) => {
    if (process.env.OPENCLAW_GATEWAY_STARTUP_TRACE === "1") {
      console.error(
        `[doctor-readiness-profile] shutdown.${phase} elapsedMs=${(performance.now() - startedAt).toFixed(1)}`,
      );
    }
  };
  const observe = <T>(phase: string, pending: Promise<T>): Promise<T> =>
    pending.then((module) => {
      trace(phase);
      return module;
    });
  const [
    { createGatewayCloseHandler, drainActiveSessionsForShutdown, runGatewayClosePrelude },
    { runGlobalGatewayStopSafely },
    { flushPendingSessionsChangedEvents },
    { closeMcpLoopbackServer },
    { stopTaskRegistryMaintenance },
    { markRestartAbortedMainSessions },
    { disposeAllBundleLspRuntimes },
    { drainRetainedOpenAiEmbeddingProviders },
    { stopGmailWatcher },
    { disposeAllCodeModeRuns },
    { closeProviderTransportDispatcherPool },
    { clearActivePluginRegistry, prepareActivePluginRegistryShutdown },
  ] = await Promise.all([
    observe("close", import("./server-close.runtime.js")),
    observe("hooks", import("../plugins/hook-runner-global.js")),
    observe("session-events", import("./server-methods/session-change-event.js")),
    observe("mcp", import("./mcp-http.js")),
    observe("task-maintenance", import("../tasks/task-registry.maintenance.js")),
    observe(
      "session-recovery",
      import("../agents/main-session-recovery/main-session-restart-recovery.js"),
    ),
    observe("bundle-lsp", import("../agents/agent-bundle-lsp-runtime.js")),
    observe("embeddings", import("./embeddings-http.js")),
    observe("gmail", import("../hooks/gmail-watcher.js")),
    observe("code-mode", import("../agents/code-mode-state.js")),
    observe("provider-transport", import("../agents/provider-transport-dispatcher-pool.js")),
    observe("plugins", import("../plugins/runtime.js")),
  ]);
  trace("imports-complete");
  await prepareActivePluginRegistryShutdown();
  trace("registry-prepared");

  return {
    createGatewayCloseHandler,
    drainActiveSessionsForShutdown,
    runGatewayClosePrelude,
    runGlobalGatewayStopSafely,
    flushPendingSessionsChangedEvents,
    closeMcpLoopbackServer,
    stopTaskRegistryMaintenance,
    markRestartAbortedMainSessions,
    disposeAllBundleLspRuntimes,
    drainRetainedOpenAiEmbeddingProviders,
    stopGmailWatcher,
    disposeAllCodeModeRuns,
    closeProviderTransportDispatcherPool,
    clearActivePluginRegistry,
  };
}

export type GatewayShutdownRuntime = Awaited<ReturnType<typeof prepareGatewayShutdownRuntime>>;

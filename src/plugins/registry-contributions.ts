import { projectPluginHttpRoutes } from "./http-route-owner.js";
import type { PluginRegistry } from "./registry-types.js";

// One inventory initializes, rolls back, and carries contributions between generations.
const pluginArrays = [
  "tools",
  "hooks",
  "typedHooks",
  "channels",
  "channelSetups",
  "providers",
  "modelCatalogProviders",
  "sessionCatalogs",
  "cliBackends",
  "textTransforms",
  "embeddingProviders",
  "speechProviders",
  "realtimeTranscriptionProviders",
  "realtimeVoiceProviders",
  "mediaUnderstandingProviders",
  "transcriptSourceProviders",
  "imageGenerationProviders",
  "videoGenerationProviders",
  "musicGenerationProviders",
  "webFetchProviders",
  "webSearchProviders",
  "migrationProviders",
  "codexAppServerExtensionFactories",
  "agentToolResultMiddlewareOwners",
  "agentToolResultMiddlewares",
  "agentHarnesses",
  "detachedTaskRuntimes",
  "legacyInternalHooks",
  "memoryCapabilities",
  "memoryCorpusSupplements",
  "memoryPromptPreparations",
  "memoryPromptSupplements",
  "httpRoutes",
  "hostedMediaResolvers",
  "widgetPresenters",
  "mcpServerConnectionResolvers",
  "cliRegistrars",
  "reloads",
  "nodeHostCommands",
  "nodeInvokePolicies",
  "securityAuditCollectors",
  "services",
  "gatewayDiscoveryServices",
  "commands",
  "interactiveHandlers",
  "sessionExtensions",
  "trustedToolPolicies",
  "toolMetadata",
  "controlUiDescriptors",
  "runtimeLifecycles",
  "agentEventSubscriptions",
  "sessionSchedulerJobs",
  "sessionActions",
  "conversationBindingResolvedHandlers",
] as const satisfies ReadonlyArray<keyof PluginRegistry>;
const pluginMaps = [
  "workerProviders",
  "sessionDiscussionProviders",
  "dashboardDataBindings",
  "dashboardActionVerbs",
  "boardWidgetContentKinds",
] as const satisfies ReadonlyArray<keyof PluginRegistry>;

export function createEmptyPluginContributions() {
  const contributions = Object.fromEntries([
    ...pluginArrays.map((key) => [key, []]),
    ...pluginMaps.map((key) => [key, new Map()]),
  ]);
  // SAFETY: The inventories enumerate array and Map fields, initialized with their empty values.
  return contributions as Pick<
    PluginRegistry,
    (typeof pluginArrays)[number] | (typeof pluginMaps)[number]
  >;
}

function projectArray<T>(source: T[], target: T[] | undefined, owns: (entry: T) => boolean): void {
  if (target) {
    target.push(...source.filter(owns));
  } else {
    for (let index = source.length - 1; index >= 0; index--) {
      if (owns(source[index]!)) {
        source.splice(index, 1);
      }
    }
  }
}

function projectMap<K, V>(
  source: Map<K, V>,
  target: Map<K, V> | undefined,
  owns: (entry: V, key: K) => boolean,
): void {
  for (const [key, entry] of source) {
    if (!owns(entry, key)) {
      continue;
    }
    if (target) {
      target.set(key, entry);
    } else {
      source.delete(key);
    }
  }
}

/** Copy exact owned contributions into a candidate, or remove them during failed registration. */
export function projectPluginContributions(
  source: PluginRegistry,
  pluginId: string,
  target?: PluginRegistry,
): void {
  projectPluginHttpRoutes(source, pluginId, target);
  for (const key of pluginArrays) {
    if (key === "httpRoutes") {
      continue;
    }
    projectArray<{ pluginId?: string }>(
      source[key],
      target?.[key],
      (entry) => entry.pluginId === pluginId,
    );
  }
  for (const key of pluginMaps) {
    projectMap<string, { pluginId: string }>(
      source[key],
      target?.[key],
      (entry) => entry.pluginId === pluginId,
    );
  }
  projectArray(
    source.compactionProviders,
    target?.compactionProviders,
    (entry) => entry.ownerPluginId === pluginId,
  );
  projectMap(
    source.contextEngines,
    target?.contextEngines,
    (entry) => entry.owner === `plugin:${pluginId}`,
  );
  projectMap(
    source.pluginRuntimeArtifacts,
    target?.pluginRuntimeArtifacts,
    // SAFETY: Runtime artifact keys are host-created JSON tuples with the owning plugin id first.
    (_entry, key) => (JSON.parse(key) as unknown[])[0] === pluginId,
  );
  const ownsMethod = (entry: PluginRegistry["gatewayMethodDescriptors"][number]) =>
    entry.owner.kind === "plugin" && entry.owner.pluginId === pluginId;
  for (const entry of source.gatewayMethodDescriptors.filter(ownsMethod)) {
    if (target) {
      target.gatewayHandlers[entry.name] = source.gatewayHandlers[entry.name]!;
    } else {
      delete source.gatewayHandlers[entry.name];
    }
  }
  projectArray(source.gatewayMethodDescriptors, target?.gatewayMethodDescriptors, ownsMethod);
}

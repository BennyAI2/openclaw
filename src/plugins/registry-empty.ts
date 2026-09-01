// Provides the empty plugin registry used before discovery completes.
import { createEmptyPluginContributions } from "./registry-contributions.js";
import type { PluginRegistry } from "./registry-types.js";

export function createEmptyPluginRegistry(): PluginRegistry {
  return {
    ...createEmptyPluginContributions(),
    plugins: [],
    pluginRuntimeArtifacts: new Map(),
    compactionProviders: [],
    contextEngines: new Map(),
    gatewayHandlers: {},
    gatewayMethodDescriptors: [],
    coreGatewayMethodNames: [],
    diagnostics: [],
  };
}

import { resolveProviderIdForAuth } from "../../agents/provider-auth-aliases.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { resolveManifestProviderAuthChoices } from "../../plugins/provider-auth-choices.js";
import { listProviderLoginOptions } from "../../plugins/provider-login-options.js";
import { supportsSetupManualSecret } from "../../system-agent/setup-inference-auth-options.js";
import type { ModelProviderCapability } from "./models-auth-status.types.js";

export function resolveModelProviderCapabilities(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  metadataSnapshot: PluginMetadataSnapshot;
  workspaceDir: string;
}): {
  capabilities: ModelProviderCapability[];
  resolveProvider: (provider: string) => string;
} {
  const env = params.env ?? process.env;
  const resolveProvider = (provider: string) =>
    resolveProviderIdForAuth(provider, {
      config: params.config,
      env,
      workspaceDir: params.workspaceDir,
      includeUntrustedWorkspacePlugins: false,
      metadataSnapshot: params.metadataSnapshot,
    });
  const capabilities = new Map<string, ModelProviderCapability>();
  const authChoices = resolveManifestProviderAuthChoices({
    config: params.config,
    env,
    workspaceDir: params.workspaceDir,
    includeUntrustedWorkspacePlugins: false,
    metadataSnapshot: params.metadataSnapshot,
  });
  const loginOptionsByChoiceId = new Map(
    listProviderLoginOptions(authChoices).map((option) => [option.id, option]),
  );
  for (const choice of authChoices) {
    const provider = resolveProvider(choice.providerId);
    const current = capabilities.get(provider);
    const apiKeySupported = choice.methodId === "api-key";
    const quickApiKeySetup = apiKeySupported && supportsSetupManualSecret(choice);
    const loginOption = loginOptionsByChoiceId.get(choice.choiceId);
    const loginOptions = [
      ...(current?.loginOptions ?? []),
      ...(loginOption && !current?.loginOptions?.some((option) => option.id === loginOption.id)
        ? [{ id: loginOption.id, label: loginOption.label, kind: loginOption.kind }]
        : []),
    ];
    capabilities.set(provider, {
      provider,
      apiKeySupported: current?.apiKeySupported === true || apiKeySupported,
      quickApiKeySetup: current?.quickApiKeySetup === true || quickApiKeySetup,
      ...(loginOptions.length > 0 ? { loginOptions } : {}),
    });
  }
  return {
    capabilities: [...capabilities.values()].toSorted((a, b) =>
      a.provider.localeCompare(b.provider),
    ),
    resolveProvider,
  };
}

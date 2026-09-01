import { resolveProviderIdForAuth } from "../../agents/provider-auth-aliases.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import {
  resolveManifestDeclaredProviderAuthChoices,
  resolveManifestProviderAuthChoices,
} from "../../plugins/provider-auth-choices.js";
import { listProviderAccessOptions } from "../../plugins/provider-login-options.js";
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
    includeWorkspacePlugins: false,
    metadataSnapshot: params.metadataSnapshot,
  });
  const accessOptionsByChoiceId = new Map(
    listProviderAccessOptions(
      resolveManifestDeclaredProviderAuthChoices({
        config: params.config,
        env,
        workspaceDir: params.workspaceDir,
        includeUntrustedWorkspacePlugins: false,
        includeWorkspacePlugins: false,
        metadataSnapshot: params.metadataSnapshot,
      }),
    ).map((option) => [option.id, option]),
  );
  for (const choice of authChoices) {
    const provider = resolveProvider(choice.providerId);
    const current = capabilities.get(provider);
    const apiKeySupported = choice.methodId === "api-key";
    const quickApiKeySetup = apiKeySupported && supportsSetupManualSecret(choice);
    const accessOption = accessOptionsByChoiceId.get(choice.choiceId);
    const accessOptions = [
      ...(current?.accessOptions ?? []),
      ...(accessOption && !current?.accessOptions?.some((option) => option.id === accessOption.id)
        ? [
            {
              id: accessOption.id,
              label: accessOption.label,
              mode: accessOption.mode,
            },
          ]
        : []),
    ];
    capabilities.set(provider, {
      provider,
      apiKeySupported: current?.apiKeySupported === true || apiKeySupported,
      quickApiKeySetup: current?.quickApiKeySetup === true || quickApiKeySetup,
      ...(accessOptions.length > 0 ? { accessOptions } : {}),
    });
  }
  return {
    capabilities: [...capabilities.values()].toSorted((a, b) =>
      a.provider.localeCompare(b.provider),
    ),
    resolveProvider,
  };
}

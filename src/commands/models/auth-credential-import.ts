import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type {
  MigrationPlan,
  MigrationProviderPlugin,
  ProviderAuthMethod,
} from "../../plugins/types.js";
import type { RuntimeEnv } from "../../runtime.js";
import { buildMigrationContext } from "../migrate/context.js";
import { applyMigrationItemSelection } from "../migrate/item-selection.js";
import { tryResolveMigrationProvider } from "../migrate/providers.js";

export type ImportedProviderCredential = {
  profileId: string;
  provider: string;
  mode: "api_key" | "oauth" | "token";
  configUpdated: boolean;
};

/** Import one provider-owned credential item before starting interactive login. */
export async function tryImportProviderCredential(params: {
  method: ProviderAuthMethod;
  config: OpenClawConfig;
  agentId: string;
  runtime: RuntimeEnv;
  credentialOnly?: boolean;
  signal?: AbortSignal;
  beforePersistentEffect?: () => void | Promise<void>;
}): Promise<ImportedProviderCredential | undefined> {
  const spec = params.method.credentialImport;
  if (!spec) {
    return undefined;
  }
  params.signal?.throwIfAborted();
  const migrationProvider: MigrationProviderPlugin | undefined = tryResolveMigrationProvider(
    spec.migrationProviderId,
    params.config,
  );
  if (!migrationProvider) {
    return undefined;
  }
  const context = buildMigrationContext({
    targetAgentId: params.agentId,
    itemKinds: ["auth"],
    includeSecrets: true,
    configOverride: params.config,
    providerOptions: params.credentialOnly ? { configPatchMode: "return" } : undefined,
    runtime: params.runtime,
  });
  if (params.signal) {
    context.signal = params.signal;
  }
  const detection = await migrationProvider.detect?.(context);
  if (detection && !detection.found) {
    return undefined;
  }
  const plan: MigrationPlan = await migrationProvider.plan(context);
  const candidate = plan.items.find(
    (item) =>
      item.id === spec.itemId &&
      item.status === "planned" &&
      item.details?.credentialKind === spec.credentialKind,
  );
  if (!candidate) {
    return undefined;
  }
  await params.beforePersistentEffect?.();
  params.signal?.throwIfAborted();
  const result = await migrationProvider.apply(
    context,
    applyMigrationItemSelection(plan, [spec.itemId]),
  );
  const imported = result.items.find(
    (item) => item.id === spec.itemId && item.status === "migrated",
  );
  const profileId = imported?.details?.profileId;
  const provider = imported?.details?.provider;
  const credentialKind = imported?.details?.credentialKind;
  if (
    typeof profileId !== "string" ||
    !profileId.trim() ||
    typeof provider !== "string" ||
    !provider.trim() ||
    credentialKind !== spec.credentialKind
  ) {
    return undefined;
  }
  return {
    profileId: profileId.trim(),
    provider: provider.trim(),
    mode: credentialKind,
    configUpdated: imported.details?.configUpdated === true,
  };
}

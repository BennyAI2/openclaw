import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { compareProviderAuthChoiceGroups } from "./provider-auth-choice-order.js";
import {
  resolveManifestProviderAuthChoices,
  type ProviderAuthChoiceMetadata,
} from "./provider-auth-choices.js";

export type ProviderLoginOption = {
  id: string;
  brandId?: string;
  label: string;
  hint?: string;
  groupLabel?: string;
  icon?: string;
  website?: string;
  kind: "oauth" | "device-code";
  featured: boolean;
};

export type ProviderChannelLoginChoice = {
  choiceId: string;
  pluginId: string;
  providerId: string;
  methodId: string;
  label: string;
  providerLabel: string;
  command: string;
};

export type ProviderChannelLoginResolution =
  | { status: "resolved"; choice: ProviderChannelLoginChoice }
  | {
      status: "ambiguous" | "unsupported";
      choices: ProviderChannelLoginChoice[];
    };

export function supportsProviderAuthChoiceTextInference(
  scopes?: ProviderAuthChoiceMetadata["onboardingScopes"],
): boolean {
  return !scopes || scopes.includes("text-inference");
}

function toProviderLoginOption(
  choice: ProviderAuthChoiceMetadata,
): ProviderLoginOption | undefined {
  const id = choice.choiceId.trim();
  if (
    !id ||
    !supportsProviderAuthChoiceTextInference(choice.onboardingScopes) ||
    choice.assistantVisibility === "manual-only" ||
    !choice.appGuidedAuth
  ) {
    return undefined;
  }
  return {
    id,
    brandId: choice.providerId,
    label: choice.choiceLabel,
    ...(choice.choiceHint?.trim() ? { hint: choice.choiceHint.trim() } : {}),
    ...(choice.groupLabel?.trim() ? { groupLabel: choice.groupLabel.trim() } : {}),
    ...(choice.icon ? { icon: choice.icon } : {}),
    ...(choice.website ? { website: choice.website } : {}),
    kind: choice.appGuidedAuth,
    featured: choice.onboardingFeatured === true,
  };
}

export function listProviderLoginOptions(
  authChoices: readonly ProviderAuthChoiceMetadata[],
): ProviderLoginOption[] {
  const choices = new Map<
    string,
    { metadata: ProviderAuthChoiceMetadata; option: ProviderLoginOption }
  >();
  for (const choice of authChoices) {
    const option = toProviderLoginOption(choice);
    if (!option || choices.has(option.id)) {
      continue;
    }
    choices.set(option.id, { metadata: choice, option });
  }
  return [...choices.values()]
    .toSorted(
      (a, b) =>
        Number(b.option.featured) - Number(a.option.featured) ||
        compareProviderAuthChoiceGroups(
          {
            id: a.metadata.groupId ?? a.metadata.providerId,
            label: a.metadata.groupLabel ?? a.metadata.choiceLabel,
          },
          {
            id: b.metadata.groupId ?? b.metadata.providerId,
            label: b.metadata.groupLabel ?? b.metadata.choiceLabel,
          },
        ) ||
        (a.metadata.assistantPriority ?? 0) - (b.metadata.assistantPriority ?? 0) ||
        a.option.label.localeCompare(b.option.label, "en") ||
        a.option.id.localeCompare(b.option.id, "en"),
    )
    .map(({ option }) => option);
}

function normalizeLoginInput(value: string | undefined): string {
  return normalizeLowercaseStringOrEmpty(value ?? "").replace(/_/gu, "-");
}

function uniqueChoices(choices: readonly ProviderChannelLoginChoice[]) {
  return [...new Map(choices.map((choice) => [choice.choiceId, choice])).values()];
}

function readProviderChannelLoginMetadata(
  params?: Parameters<typeof resolveManifestProviderAuthChoices>[0],
): ProviderAuthChoiceMetadata[] {
  return resolveManifestProviderAuthChoices({
    ...params,
    includeUntrustedWorkspacePlugins: false,
    includeWorkspacePlugins: false,
  }).filter((choice) => choice.channelLogin);
}

function projectProviderChannelLoginChoices(
  metadata: readonly ProviderAuthChoiceMetadata[],
): ProviderChannelLoginChoice[] {
  const providerCounts = new Map<string, number>();
  for (const choice of metadata) {
    const provider = normalizeLoginInput(choice.providerId);
    providerCounts.set(provider, (providerCounts.get(provider) ?? 0) + 1);
  }
  return metadata
    .map((choice) => {
      const firstAlias = choice.channelLogin?.aliases?.[0];
      const provider = normalizeLoginInput(choice.providerId);
      return {
        choiceId: choice.choiceId,
        pluginId: choice.pluginId,
        providerId: choice.providerId,
        methodId: choice.methodId,
        label: choice.choiceLabel,
        providerLabel: choice.groupLabel?.trim() || choice.choiceLabel,
        command:
          firstAlias ??
          ((providerCounts.get(provider) ?? 0) === 1 ? choice.providerId : choice.choiceId),
      };
    })
    .toSorted(
      (a, b) => a.label.localeCompare(b.label, "en") || a.choiceId.localeCompare(b.choiceId),
    );
}

export function listProviderChannelLoginChoices(
  params?: Parameters<typeof resolveManifestProviderAuthChoices>[0],
): ProviderChannelLoginChoice[] {
  return projectProviderChannelLoginChoices(readProviderChannelLoginMetadata(params));
}

export function resolveProviderChannelLoginChoice(
  input: string | undefined,
  params?: Parameters<typeof resolveManifestProviderAuthChoices>[0],
): ProviderChannelLoginResolution {
  const metadata = readProviderChannelLoginMetadata(params);
  const choices = projectProviderChannelLoginChoices(metadata);
  const byChoiceId = new Map(choices.map((choice) => [choice.choiceId, choice]));
  const normalized = normalizeLoginInput(input);
  const select = (matches: readonly ProviderAuthChoiceMetadata[]) => {
    const resolved = uniqueChoices(
      matches.flatMap((choice) => {
        const projected = byChoiceId.get(choice.choiceId);
        return projected ? [projected] : [];
      }),
    ).toSorted(
      (a, b) => a.label.localeCompare(b.label, "en") || a.choiceId.localeCompare(b.choiceId),
    );
    return resolved.length === 1
      ? ({ status: "resolved", choice: resolved[0]! } as const)
      : ({ status: "ambiguous", choices: resolved.length > 0 ? resolved : choices } as const);
  };
  if (!normalized) {
    const defaults = metadata.filter((choice) => choice.channelLogin?.default === true);
    return defaults.length > 0 ? select(defaults) : { status: "unsupported", choices };
  }
  const exactChoices = metadata.filter(
    (choice) => normalizeLoginInput(choice.choiceId) === normalized,
  );
  if (exactChoices.length > 0) {
    return select(exactChoices);
  }
  const providerOrGroup = metadata.filter(
    (choice) =>
      normalizeLoginInput(choice.providerId) === normalized ||
      normalizeLoginInput(choice.groupId) === normalized,
  );
  if (providerOrGroup.length > 0) {
    return select(providerOrGroup);
  }
  const aliases = metadata.filter((choice) =>
    choice.channelLogin?.aliases?.some((alias) => normalizeLoginInput(alias) === normalized),
  );
  return aliases.length > 0 ? select(aliases) : { status: "unsupported", choices };
}

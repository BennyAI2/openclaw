import type {
  AudioTranscriptionRequest,
  MediaUnderstandingProvider,
} from "openclaw/plugin-sdk/media-understanding";
import { transcribeOpenAiCompatibleAudio } from "openclaw/plugin-sdk/media-understanding";
import {
  findNormalizedProviderValue,
  hasConfiguredSecretInput,
  resolveOpenAICodexAuthIdentity,
} from "openclaw/plugin-sdk/provider-auth";
import {
  collectProviderApiKeysForExecution,
  executeWithApiKeyRotation,
  isProviderAuthError,
  requireApiKey,
  resolveApiKeyForProvider,
  resolveProviderAuthProfileMetadata,
} from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  assertOkOrThrowHttpError,
  buildAudioTranscriptionFormData,
  postTranscriptionRequest,
  providerOperationRetryConfig,
  readProviderJsonObjectResponse,
  requireTranscriptionText,
} from "openclaw/plugin-sdk/provider-http";
import { classifyOpenAIBaseUrl, OPENAI_API_BASE_URL } from "./base-url.js";
import { OPENAI_DEFAULT_AUDIO_TRANSCRIPTION_MODEL } from "./default-models.js";

const CHATGPT_TRANSCRIPTION_URL = "https://chatgpt.com/backend-api/transcribe";

export async function transcribeOpenAiAudio(params: AudioTranscriptionRequest) {
  return await transcribeOpenAiCompatibleAudio({
    ...params,
    provider: "openai",
    defaultBaseUrl: OPENAI_API_BASE_URL,
    defaultModel: OPENAI_DEFAULT_AUDIO_TRANSCRIPTION_MODEL,
  });
}

export const prepareOpenAiAudioTranscription: NonNullable<
  MediaUnderstandingProvider["prepareAudioTranscription"]
> = async (context) => {
  const providerConfig = findNormalizedProviderValue(context.cfg.models?.providers, "openai");
  const hasConfiguredKey = hasConfiguredSecretInput(
    providerConfig?.apiKey,
    context.cfg.secrets?.defaults,
  );
  const endpointKind = classifyOpenAIBaseUrl(context.baseUrl);
  const nativeEndpoint =
    endpointKind === "unresolved" || endpointKind === "platform" || endpointKind === "chatgpt";
  // Audio's authored provider key owns billing before ambient profiles. This request-local
  // projection preserves that order without changing the agent's text-inference configuration.
  const cfg =
    !context.profile &&
    providerConfig &&
    hasConfiguredKey &&
    (!providerConfig.auth || providerConfig.auth === "api-key")
      ? {
          ...context.cfg,
          models: {
            ...context.cfg.models,
            providers: {
              ...context.cfg.models?.providers,
              openai: { ...providerConfig, auth: "api-key" as const },
            },
          },
        }
      : context.cfg;
  const params = {
    provider: "openai",
    cfg,
    agentDir: context.agentDir,
    workspaceDir: context.workspaceDir,
    profileId: context.profile,
    preferredProfile: context.preferredProfile,
    lockedProfile: Boolean(context.profile),
  };
  const explicitSubscription = providerConfig?.auth === "oauth" || providerConfig?.auth === "token";
  const auth = await resolveApiKeyForProvider({
    ...params,
    modelApi: context.profile || explicitSubscription ? undefined : "openai-audio-transcriptions",
  }).catch((error: unknown) => {
    if (
      context.profile ||
      hasConfiguredKey ||
      !nativeEndpoint ||
      !isProviderAuthError(error, "missing-provider-auth")
    ) {
      throw error;
    }
    // Missing Platform credentials may select the subscription route; failed credentials
    // never trigger a switch to another account or billing surface.
    return resolveApiKeyForProvider(params);
  });
  const credential = requireApiKey(auth, "openai");
  if (auth.mode === "api-key") {
    const apiKeys = collectProviderApiKeysForExecution({
      provider: "openai",
      primaryApiKey: credential,
    });
    return async (input) =>
      await executeWithApiKeyRotation({
        provider: "openai",
        apiKeys,
        transientRetry: providerOperationRetryConfig("read"),
        execute: async (apiKey) =>
          transcribeOpenAiAudio({
            ...input,
            // The inherited provider URL can target ChatGPT text inference. Audio's
            // resolved credential class owns the official endpoint and billing surface.
            baseUrl: nativeEndpoint ? OPENAI_API_BASE_URL : context.baseUrl,
            headers: context.headers,
            request: context.request,
            apiKey,
            auth: { kind: "api-key", apiKey },
          }),
      });
  }
  if (auth.mode !== "oauth" && auth.mode !== "token") {
    throw new Error(
      "OpenAI audio transcription requires an API key or ChatGPT subscription profile.",
    );
  }
  if (!nativeEndpoint) {
    throw new Error(
      "ChatGPT audio transcription cannot use a custom endpoint. Select an OpenAI API-key profile for this audio model.",
    );
  }
  if (context.requestedModel?.trim() || context.prompt?.trim()) {
    throw new Error(
      "OpenClaw's ChatGPT audio integration uses the service defaults. Model and prompt overrides require an OpenAI API-key profile; remove the audio overrides or select that profile.",
    );
  }
  if (context.headers || context.request) {
    throw new Error(
      "ChatGPT audio transcription does not support custom request overrides. Remove the audio overrides or select an OpenAI API-key profile.",
    );
  }
  const metadata = auth.profileId
    ? resolveProviderAuthProfileMetadata({
        provider: "openai",
        cfg: context.cfg,
        agentDir: context.agentDir,
        profileId: auth.profileId,
      })
    : undefined;
  const accountId = resolveOpenAICodexAuthIdentity({
    access: credential,
    accountId: metadata?.accountId,
  }).accountId;
  if (!accountId) {
    throw new Error(
      "The selected ChatGPT audio profile is missing its account id. Sign in to OpenAI again.",
    );
  }
  return async (input) => {
    const { response, release } = await postTranscriptionRequest({
      url: CHATGPT_TRANSCRIPTION_URL,
      headers: new Headers({
        authorization: `Bearer ${credential}`,
        "ChatGPT-Account-ID": accountId,
      }),
      body: buildAudioTranscriptionFormData({
        buffer: input.buffer,
        fileName: input.fileName,
        mime: input.mime,
        fields: { language: input.language },
      }),
      timeoutMs: input.timeoutMs,
      signal: input.signal,
      fetchFn: input.fetchFn ?? fetch,
      pinDns: false,
    });
    try {
      await assertOkOrThrowHttpError(response, "ChatGPT audio transcription failed");
      const payload = await readProviderJsonObjectResponse(
        response,
        "ChatGPT audio transcription failed",
      );
      return {
        text: requireTranscriptionText(
          typeof payload.text === "string" ? payload.text : undefined,
          "ChatGPT audio transcription response missing text",
        ),
      };
    } finally {
      await release();
    }
  };
};

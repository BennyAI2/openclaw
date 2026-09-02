// Openai tests cover media understanding provider plugin behavior.
import { withEnvAsync } from "openclaw/plugin-sdk/test-env";
import {
  createAuthCaptureJsonFetch,
  createRequestCaptureJsonFetch,
  installPinnedHostnameTestHooks,
} from "openclaw/plugin-sdk/test-media-understanding";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { openaiMediaUnderstandingProvider } from "./media-understanding-provider.js";

const authMocks = vi.hoisted(() => ({ resolve: vi.fn(), metadata: vi.fn() }));
vi.mock("openclaw/plugin-sdk/provider-auth-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth-runtime")>()),
  resolveApiKeyForProvider: authMocks.resolve,
  resolveProviderAuthProfileMetadata: authMocks.metadata,
}));

installPinnedHostnameTestHooks();

beforeEach(() => {
  authMocks.resolve.mockReset();
  authMocks.metadata.mockReset().mockReturnValue({});
});

describe("openaiMediaUnderstandingProvider", () => {
  it("declares audio support with the transcription default", () => {
    expect(openaiMediaUnderstandingProvider.capabilities).toEqual(["image", "audio"]);
    expect(openaiMediaUnderstandingProvider.defaultModels).toEqual({
      image: "gpt-5.6-sol",
      audio: "gpt-4o-transcribe",
    });
    expect(openaiMediaUnderstandingProvider.autoPriority).toEqual({ image: 20, audio: 20 });
    expect(openaiMediaUnderstandingProvider.transcribeAudio).toBeTypeOf("function");
  });
});

describe("provider-prepared audio transcription", () => {
  const token = `fixture.${Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" },
    }),
  ).toString("base64url")}.signature`;

  function useOAuth() {
    authMocks.resolve.mockResolvedValue({
      apiKey: token,
      mode: "oauth",
      source: "profile:openai:audio",
    });
  }

  it.each([undefined, "https://api.openai.com", "https://chatgpt.com/backend-api/codex"])(
    "routes subscription audio from official base %s to the fixed ChatGPT endpoint",
    async (baseUrl) => {
      useOAuth();
      const { fetchFn, getRequest } = createRequestCaptureJsonFetch({ text: "Hallo" });
      const transcribe = await openaiMediaUnderstandingProvider.prepareAudioTranscription!({
        cfg: {},
        agentDir: "/fixture/agents/audio",
        profile: "openai:audio",
        baseUrl,
      });
      const result = await transcribe({
        buffer: Buffer.from("audio"),
        fileName: "voice.wav",
        language: "de",
        timeoutMs: 1000,
        fetchFn,
      });
      const { url, init } = getRequest();
      expect(url).toBe("https://chatgpt.com/backend-api/transcribe");
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${token}`);
      expect(new Headers(init?.headers).get("ChatGPT-Account-ID")).toBe("fixture-account");
      expect((init?.body as FormData).get("language")).toBe("de");
      expect((init?.body as FormData).has("model")).toBe(false);
      expect(result).toEqual({ text: "Hallo" });
      expect(authMocks.metadata).not.toHaveBeenCalled();
      expect(authMocks.resolve).toHaveBeenCalledWith(
        expect.objectContaining({
          agentDir: "/fixture/agents/audio",
          profileId: "openai:audio",
          lockedProfile: true,
        }),
      );
    },
  );

  it.each(["first", "second"])(
    "uses only the selected %s account metadata for an opaque OAuth token",
    async (selected) => {
      const profileId = `openai:${selected}`;
      authMocks.resolve.mockResolvedValue({
        apiKey: "opaque-fixture-access",
        mode: "oauth",
        profileId,
        source: `profile:${profileId}`,
      });
      authMocks.metadata.mockImplementation((params: { profileId?: string }) => ({
        accountId: params.profileId === "openai:second" ? "second-account" : "first-account",
      }));
      const transcribe = await openaiMediaUnderstandingProvider.prepareAudioTranscription!({
        cfg: {},
        agentDir: "/fixture/agents/worker",
      });
      const { fetchFn, getRequest } = createRequestCaptureJsonFetch({ text: "account transcript" });
      await transcribe({
        buffer: Buffer.from("audio"),
        fileName: "voice.wav",
        timeoutMs: 1000,
        fetchFn,
      });
      expect(new Headers(getRequest().init?.headers).get("ChatGPT-Account-ID")).toBe(
        `${selected}-account`,
      );
      expect(authMocks.metadata).toHaveBeenCalledExactlyOnceWith({
        provider: "openai",
        cfg: {},
        agentDir: "/fixture/agents/worker",
        profileId,
      });
    },
  );

  it.each([undefined, "", " \t "])(
    "resolves subscription auth through the real resolver with absent key %j",
    async (apiKey) =>
      withEnvAsync({ OPENAI_API_KEY: undefined }, async () => {
        const [
          { createPluginRegistryFixture },
          { createPluginRecord },
          { withPluginRuntimeRegistryScope },
          { default: plugin },
        ] = await Promise.all([
          import("openclaw/plugin-sdk/plugin-test-contracts"),
          import("openclaw/plugin-sdk/plugin-test-runtime"),
          import("openclaw/plugin-sdk/channel-test-helpers"),
          import("./index.js"),
        ]);
        const cfg = {
          auth: { order: { openai: ["openai:fixture-subscription"] } },
          models: {
            providers: {
              openai: { apiKey, baseUrl: "https://api.openai.com/v1", models: [] },
            },
          },
        };
        const { registry } = createPluginRegistryFixture(cfg);
        const record = createPluginRecord({ id: "openai" });
        registry.registry.plugins.push(record);
        // Capability discovery registers the provider before its media callback runs.
        plugin.register(registry.createApi(record, { config: cfg, registrationMode: "discovery" }));
        const realAuth = await vi.importActual<
          typeof import("openclaw/plugin-sdk/provider-auth-runtime")
        >("openclaw/plugin-sdk/provider-auth-runtime");
        authMocks.resolve.mockImplementation((params) =>
          realAuth.resolveApiKeyForProvider({
            ...params,
            store: {
              version: 1,
              profiles: {
                "openai:fixture-subscription": { type: "token", provider: "openai", token },
              },
            },
          }),
        );
        try {
          await withPluginRuntimeRegistryScope(registry.registry, async () => {
            const provider = registry.registry.mediaUnderstandingProviders.find(
              (entry) => entry.provider.id === "openai",
            )?.provider;
            if (!provider?.prepareAudioTranscription) {
              throw new Error("OpenAI audio preparation registration missing");
            }
            const transcribe = await provider.prepareAudioTranscription({ cfg });
            const { fetchFn, getRequest } = createRequestCaptureJsonFetch({ text: "subscription" });
            await transcribe({
              buffer: Buffer.from("audio"),
              fileName: "voice.wav",
              timeoutMs: 1000,
              fetchFn,
            });
            expect(getRequest().url).toBe("https://chatgpt.com/backend-api/transcribe");
            expect(authMocks.resolve).toHaveBeenCalledTimes(2);
          });
        } finally {
          registry.rollbackPluginGlobalSideEffects(record.id, record);
        }
      }),
  );

  it.each([
    ["https://api.openai.com/v1", "https://api.openai.com/v1/audio/transcriptions"],
    ["https://chatgpt.com/backend-api/codex", "https://api.openai.com/v1/audio/transcriptions"],
    ["https://custom.example/v1", "https://custom.example/v1/audio/transcriptions"],
  ])(
    "keeps an authored API key ahead of OAuth with provider base %s",
    async (baseUrl, expectedUrl) => {
      authMocks.resolve.mockResolvedValue({
        apiKey: "fixture-platform-key",
        mode: "api-key",
        source: "models.json",
      });
      const cfg = {
        auth: { order: { openai: ["openai:chatgpt", "openai:audio"] } },
        models: {
          providers: {
            openai: {
              baseUrl,
              apiKey: "fixture-platform-key",
              models: [],
            },
          },
        },
      };
      const original = structuredClone(cfg);
      const transcribe = await openaiMediaUnderstandingProvider.prepareAudioTranscription!({
        cfg,
        baseUrl,
      });
      const { fetchFn, getRequest } = createRequestCaptureJsonFetch({ text: "hello" });
      await transcribe({
        buffer: Buffer.from("audio"),
        fileName: "voice.wav",
        model: "gpt-4o-mini-transcribe",
        prompt: "Names: Ada",
        timeoutMs: 1000,
        fetchFn,
      });
      expect(cfg).toEqual(original);
      expect(authMocks.resolve).toHaveBeenCalledTimes(1);
      expect(authMocks.resolve).toHaveBeenCalledWith(
        expect.objectContaining({
          modelApi: "openai-audio-transcriptions",
          cfg: expect.objectContaining({
            models: { providers: { openai: { ...cfg.models.providers.openai, auth: "api-key" } } },
          }),
        }),
      );
      const { url, init } = getRequest();
      expect(url).toBe(expectedUrl);
      expect((init?.body as FormData).get("model")).toBe("gpt-4o-mini-transcribe");
      expect((init?.body as FormData).get("prompt")).toBe("Names: Ada");
    },
  );

  it.each([
    { baseUrl: "https://custom.example/v1" },
    { baseUrl: "https://api.openai.com:8443/v1" },
    { baseUrl: "https://api.openai.com/v1?alternate=true" },
    { headers: { authorization: "Bearer other" } },
    { prompt: "Translate to French" },
    { requestedModel: "gpt-4o-mini-transcribe" },
  ])("rejects unsupported subscription request settings before upload: %j", async (settings) => {
    useOAuth();
    await expect(
      openaiMediaUnderstandingProvider.prepareAudioTranscription!({
        cfg: {},
        profile: "openai:audio",
        ...settings,
      }),
    ).rejects.toThrow(/API-key profile/);
  });

  it("does not switch billing routes after an authored credential failure", async () => {
    const failure = new Error("selected profile could not refresh");
    authMocks.resolve.mockRejectedValue(failure);
    await expect(
      openaiMediaUnderstandingProvider.prepareAudioTranscription!({ cfg: {} }),
    ).rejects.toBe(failure);
    expect(authMocks.resolve).toHaveBeenCalledTimes(1);
  });
});

describe("transcribeOpenAiAudio", () => {
  it("respects lowercase authorization header overrides", async () => {
    const { fetchFn, getAuthHeader } = createAuthCaptureJsonFetch({ text: "ok" });

    const result = await openaiMediaUnderstandingProvider.transcribeAudio!({
      buffer: Buffer.from("audio"),
      fileName: "note.mp3",
      apiKey: "test-key",
      timeoutMs: 1000,
      headers: { authorization: "Bearer override" },
      fetchFn,
    });

    expect(getAuthHeader()).toBe("Bearer override");
    expect(result.text).toBe("ok");
  });

  it("builds the expected request payload", async () => {
    const { fetchFn, getRequest } = createRequestCaptureJsonFetch({ text: "hello" });

    const result = await openaiMediaUnderstandingProvider.transcribeAudio!({
      buffer: Buffer.from("audio-bytes"),
      fileName: "voice.wav",
      apiKey: "test-key",
      timeoutMs: 1234,
      baseUrl: "https://api.example.com/v1/",
      model: " ",
      language: " en ",
      prompt: " hello ",
      mime: "audio/wav",
      headers: { "X-Custom": "1" },
      fetchFn,
    });
    const { url: seenUrl, init: seenInit } = getRequest();

    expect(result.model).toBe("gpt-4o-transcribe");
    expect(result.text).toBe("hello");
    expect(seenUrl).toBe("https://api.example.com/v1/audio/transcriptions");
    expect(seenInit?.method).toBe("POST");
    expect(seenInit?.signal).toBeInstanceOf(AbortSignal);

    const headers = new Headers(seenInit?.headers);
    expect(headers.get("authorization")).toBe("Bearer test-key");
    expect(headers.get("x-custom")).toBe("1");

    const form = seenInit?.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("model")).toBe("gpt-4o-transcribe");
    expect(form.get("language")).toBe("en");
    expect(form.get("prompt")).toBe("hello");
    const file = form.get("file") as Blob | { type?: string; name?: string } | null;
    if (!file) {
      throw new Error("expected OpenAI audio file");
    }
    expect(file.type).toBe("audio/wav");
    if (file && "name" in file && typeof file.name === "string") {
      expect(file.name).toBe("voice.wav");
    }
  });

  it("throws when the provider response omits text", async () => {
    const { fetchFn } = createRequestCaptureJsonFetch({});

    await expect(
      openaiMediaUnderstandingProvider.transcribeAudio!({
        buffer: Buffer.from("audio-bytes"),
        fileName: "voice.wav",
        apiKey: "test-key",
        timeoutMs: 1234,
        fetchFn,
      }),
    ).rejects.toThrow("Audio transcription response missing text");
  });
});

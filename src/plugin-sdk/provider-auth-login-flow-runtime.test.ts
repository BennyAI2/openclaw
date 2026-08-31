import { describe, expect, it, vi } from "vitest";
import {
  decideProviderLoginSessionAdoption,
  providerChannelLoginRuntime,
  type ProviderChannelLoginChoice,
  type ProviderLoginSessionEntry,
} from "./provider-auth-login-flow-runtime.js";

const choice: ProviderChannelLoginChoice = {
  choiceId: "xai-oauth",
  providerId: "xai",
  methodId: "oauth",
  label: "xAI OAuth",
  providerLabel: "xAI (Grok)",
  command: "xai",
};

const snapshot: ProviderLoginSessionEntry = {
  sessionId: "session-1",
  authProfileOverride: "xai:old",
  authProfileOverrideSource: "user",
};

describe("provider channel login runtime", () => {
  it("fails closed when an offered provider asks chat for extra input", async () => {
    const sendMessage = vi.fn(async () => {});

    await expect(
      providerChannelLoginRuntime.runLoginFlow({
        choice,
        agentId: "main",
        config: {},
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        sendMessage,
        unsupportedPromptMessage: "Open Control UI → Models and choose Sign in.",
        runLoginFlow: async (options) => {
          await options.prompter.text({ message: "Enter a secret" });
          return { providerId: "xai", methodId: "oauth", profiles: [] };
        },
      }),
    ).rejects.toThrow("Open Control UI");
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith(
      "Open Control UI → Models and choose Sign in.",
    );
  });

  it.each([
    {
      name: "patches an unchanged authoritative snapshot",
      params: {
        currentModelProvider: "xai",
        loginProvider: "xai",
        nextProfileId: "xai:new",
        snapshot,
        current: snapshot,
      },
      status: "patch",
    },
    {
      name: "rejects a profile changed during login",
      params: {
        currentModelProvider: "xai",
        loginProvider: "xai",
        nextProfileId: "xai:new",
        snapshot,
        current: { ...snapshot, authProfileOverride: "xai:concurrent" },
      },
      status: "rejected",
    },
    {
      name: "does not pin credentials for another model provider",
      params: {
        currentModelProvider: "openai",
        loginProvider: "xai",
        nextProfileId: "xai:new",
        snapshot,
        current: snapshot,
      },
      status: "unchanged",
    },
    {
      name: "rejects a later user choice on a newly created session",
      params: {
        currentModelProvider: "xai",
        loginProvider: "xai",
        nextProfileId: "xai:new",
        snapshot: undefined,
        current: { ...snapshot, authProfileOverride: "xai:later" },
      },
      status: "rejected",
    },
  ])("$name", ({ params, status }) => {
    expect(decideProviderLoginSessionAdoption(params)).toMatchObject({ status });
  });
});

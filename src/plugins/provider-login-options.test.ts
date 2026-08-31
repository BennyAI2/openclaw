import { describe, expect, it } from "vitest";
import {
  listProviderChannelLoginChoices,
  resolveProviderChannelLoginChoice,
} from "./provider-login-options.js";

function metadataSnapshot(
  providerAuthChoices: Array<Record<string, unknown>>,
  origin: "bundled" | "workspace" = "bundled",
) {
  return {
    manifestRegistry: {
      plugins: [{ id: "test-provider", origin, providerAuthChoices }],
    },
  } as never;
}

function choice(params: {
  provider: string;
  method: string;
  choiceId: string;
  aliases?: string[];
  default?: boolean;
}) {
  return {
    provider: params.provider,
    method: params.method,
    choiceId: params.choiceId,
    choiceLabel: params.choiceId,
    channelLogin: {
      ...(params.aliases ? { aliases: params.aliases } : {}),
      ...(params.default ? { default: true } : {}),
    },
  };
}

describe("provider channel login choices", () => {
  it("lists the trusted bundled fixed-input login surface", () => {
    expect(listProviderChannelLoginChoices()).toEqual([
      expect.objectContaining({ command: "codex", providerId: "openai", methodId: "device-code" }),
      expect.objectContaining({
        command: "minimax-cn-oauth",
        providerId: "minimax-portal",
        methodId: "oauth-cn",
      }),
      expect.objectContaining({
        command: "minimax-global-oauth",
        providerId: "minimax-portal",
        methodId: "oauth",
      }),
      expect.objectContaining({ command: "xai", providerId: "xai", methodId: "oauth" }),
    ]);
  });

  it("prefers an exact choice id over a colliding alias", () => {
    const snapshot = metadataSnapshot([
      choice({ provider: "alpha", method: "oauth", choiceId: "alpha", aliases: ["shared"] }),
      choice({ provider: "beta", method: "oauth", choiceId: "shared" }),
    ]);

    expect(resolveProviderChannelLoginChoice("shared", { metadataSnapshot: snapshot })).toEqual({
      status: "resolved",
      choice: expect.objectContaining({ choiceId: "shared", providerId: "beta" }),
    });
  });

  it.each([
    {
      name: "provider id",
      input: "shared",
      choices: [
        choice({ provider: "shared", method: "one", choiceId: "shared-one" }),
        choice({ provider: "shared", method: "two", choiceId: "shared-two" }),
      ],
    },
    {
      name: "alias",
      input: "shared",
      choices: [
        choice({ provider: "one", method: "oauth", choiceId: "one", aliases: ["shared"] }),
        choice({ provider: "two", method: "oauth", choiceId: "two", aliases: ["shared"] }),
      ],
    },
    {
      name: "default",
      input: undefined,
      choices: [
        choice({ provider: "one", method: "oauth", choiceId: "one", default: true }),
        choice({ provider: "two", method: "oauth", choiceId: "two", default: true }),
      ],
    },
  ])("refuses a colliding $name", ({ input, choices }) => {
    const result = resolveProviderChannelLoginChoice(input, {
      metadataSnapshot: metadataSnapshot(choices),
    });

    expect(result.status).toBe("ambiguous");
    expect(
      result.status === "ambiguous" ? result.choices.map((entry) => entry.choiceId) : [],
    ).toEqual(choices.map((entry) => entry.choiceId));
  });

  it("excludes workspace manifests even when they declare channel login", () => {
    const result = resolveProviderChannelLoginChoice("workspace-provider", {
      metadataSnapshot: metadataSnapshot(
        [choice({ provider: "workspace-provider", method: "oauth", choiceId: "workspace" })],
        "workspace",
      ),
    });

    expect(result).toEqual({ status: "unsupported", choices: [] });
  });
});

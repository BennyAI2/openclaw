import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleConnectCallbackRequest,
  resetUsersAuthConnectForTest,
  usersAuthConnectHandlers,
} from "./users-auth-connect.js";

const getUserProfileListItem = vi.hoisted(() => vi.fn());
const resolveUserProfileId = vi.hoisted(() => vi.fn());
const ensureProfileForEmail = vi.hoisted(() => vi.fn());
const listUserProfileAuthLinks = vi.hoisted(() => vi.fn());
const setUserProfileAuthLink = vi.hoisted(() => vi.fn());
const ensureAuthProfileStoreWithoutExternalProfiles = vi.hoisted(() => vi.fn());
const upsertAuthProfileAfterLoginWithLockOrThrow = vi.hoisted(() => vi.fn());
const upsertAuthProfileWithLockOrThrow = vi.hoisted(() => vi.fn());
const refreshRunningGatewayAuthState = vi.hoisted(() => vi.fn());
const registerSecretValueForRedaction = vi.hoisted(() => vi.fn());
const resolveOpenAICodexAuthIdentity = vi.hoisted(() => vi.fn());
const createOpenAIAuthorizationFlow = vi.hoisted(() => vi.fn());
const exchangeOpenAIAuthorizationCode = vi.hoisted(() => vi.fn());

vi.mock("../../state/user-profiles.js", () => ({
  ensureProfileForEmail,
  getUserProfileListItem,
  resolveUserProfileId,
  UserProfileNotFoundError: class UserProfileNotFoundError extends Error {},
}));

vi.mock("../../state/user-profile-auth-links.js", () => ({
  listUserProfileAuthLinks,
  setUserProfileAuthLink,
}));

vi.mock("../../agents/auth-profiles/shared-main-dir.js", () => ({
  resolveSharedMainAuthAgentDir: () => "/tmp/shared-main-agent",
}));

vi.mock("../../agents/auth-profiles/store.js", () => ({
  ensureAuthProfileStoreWithoutExternalProfiles,
}));

vi.mock("../../agents/auth-profiles/upsert-with-lock.js", () => ({
  upsertAuthProfileAfterLoginWithLockOrThrow,
  upsertAuthProfileWithLockOrThrow,
}));

vi.mock("../../commands/models/auth-refresh.js", () => ({ refreshRunningGatewayAuthState }));

vi.mock("../../logging/secret-redaction-registry.js", () => ({ registerSecretValueForRedaction }));

vi.mock("../../plugin-sdk/facade-runtime.js", () => ({
  loadActivatedBundledPluginPublicSurfaceModuleSync: () => ({
    createOpenAIAuthorizationFlow,
    resolveOpenAICallbackHost: () => "localhost",
    resolveOpenAIRedirectUri: (host: string) => `http://${host}:1455/auth/callback`,
    exchangeOpenAIAuthorizationCode,
  }),
}));

vi.mock("../../plugin-sdk/provider-auth.js", () => ({ resolveOpenAICodexAuthIdentity }));

const SETUP_TOKEN = `sk-ant-oat01-${"a".repeat(80)}`;

const adminClient = { connect: { scopes: ["operator.admin"] } };

async function runHandler(
  method: keyof typeof usersAuthConnectHandlers,
  params: object,
  client: object = adminClient,
) {
  const respond = vi.fn();
  await expectDefined(
    usersAuthConnectHandlers[method],
    `${method} test invariant`,
  )({ client, context: {}, params, respond } as never);
  return respond;
}

async function startFlow(profileId = "profile-1") {
  const respond = await runHandler("users.authConnect.start", { profileId, provider: "openai" });
  expect(respond).toHaveBeenCalledWith(
    true,
    expect.objectContaining({ connectId: expect.any(String) }),
  );
  return respond.mock.calls[0]?.[1] as { connectId: string; url: string };
}

describe("users auth connect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUserProfileListItem.mockImplementation((profileId: string) => ({
      id: profileId,
      displayName: "Ada",
      emails: ["ada@example.com"],
    }));
    resolveUserProfileId.mockImplementation((profileId: string) => profileId);
    ensureProfileForEmail.mockReturnValue({ id: "profile-1" });
    listUserProfileAuthLinks.mockReturnValue([]);
    setUserProfileAuthLink.mockImplementation(
      (params: { provider: string; authProfileId: string }) => [
        { provider: params.provider, authProfileId: params.authProfileId, updatedAt: 1 },
      ],
    );
    ensureAuthProfileStoreWithoutExternalProfiles.mockReturnValue({ version: 1, profiles: {} });
    createOpenAIAuthorizationFlow.mockResolvedValue({
      verifier: "pkce-verifier",
      redirectUri: "http://localhost:1455/auth/callback",
      state: "flow-state",
      url: "https://auth.openai.com/oauth/authorize?state=flow-state",
    });
    exchangeOpenAIAuthorizationCode.mockResolvedValue({
      type: "success",
      access: "access-token",
      refresh: "refresh-token",
      expires: 123,
    });
    resolveOpenAICodexAuthIdentity.mockReturnValue({ accountId: "acct-1" });
    refreshRunningGatewayAuthState.mockResolvedValue(undefined);
  });

  afterEach(() => {
    resetUsersAuthConnectForTest();
  });

  it("completes a local sign-in through the loopback callback handler", async () => {
    await startFlow("profile-cb");

    const hit = await handleConnectCallbackRequest("/auth/callback?code=cb-code&state=flow-state");

    expect(hit.status).toBe(200);
    expect(hit.body).toContain("connected");
    expect(exchangeOpenAIAuthorizationCode).toHaveBeenCalledWith(
      "cb-code",
      "pkce-verifier",
      "http://localhost:1455/auth/callback",
    );
    expect(setUserProfileAuthLink).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: "profile-cb", provider: "openai" }),
    );
    // The caught code is single-use secret material.
    expect(registerSecretValueForRedaction).toHaveBeenCalledWith("cb-code");

    // Single-use: the same state no longer resolves a pending flow.
    const replay = await handleConnectCallbackRequest(
      "/auth/callback?code=cb-code&state=flow-state",
    );
    expect(replay.status).toBe(410);
  });

  it("rejects a callback whose state matches no pending flow", async () => {
    await startFlow("profile-cb2");

    const hit = await handleConnectCallbackRequest("/auth/callback?code=cb-code&state=unknown");

    expect(hit.status).toBe(410);
    expect(exchangeOpenAIAuthorizationCode).not.toHaveBeenCalled();
    expect(upsertAuthProfileAfterLoginWithLockOrThrow).not.toHaveBeenCalled();
  });

  it("serves a canned failure page when OpenAI refuses the callback exchange", async () => {
    exchangeOpenAIAuthorizationCode.mockResolvedValue({
      type: "failed",
      status: 400,
      message: "raw body",
    });
    await startFlow("profile-cb3");

    const hit = await handleConnectCallbackRequest("/auth/callback?code=cb-code&state=flow-state");

    expect(hit.status).toBe(502);
    expect(hit.body).not.toContain("raw body");
    expect(upsertAuthProfileAfterLoginWithLockOrThrow).not.toHaveBeenCalled();
  });

  it("starts a flow and completes it into a stored linked credential", async () => {
    const flow = await startFlow();
    expect(createOpenAIAuthorizationFlow).toHaveBeenCalledWith(
      "openclaw",
      "http://localhost:1455/auth/callback",
    );

    const respond = await runHandler("users.authConnect.complete", {
      profileId: "profile-1",
      connectId: flow.connectId,
      redirectInput: "http://localhost:1455/auth/callback?code=auth-code&state=flow-state",
    });

    expect(exchangeOpenAIAuthorizationCode).toHaveBeenCalledWith(
      "auth-code",
      "pkce-verifier",
      "http://localhost:1455/auth/callback",
    );
    expect(upsertAuthProfileAfterLoginWithLockOrThrow).toHaveBeenCalledWith({
      profileId: "openai:ada",
      credential: {
        type: "oauth",
        provider: "openai",
        access: "access-token",
        refresh: "refresh-token",
        expires: 123,
        accountId: "acct-1",
      },
    });
    expect(setUserProfileAuthLink).toHaveBeenCalledWith({
      profileId: "profile-1",
      provider: "openai",
      authProfileId: "openai:ada",
    });
    expect(respond).toHaveBeenCalledWith(true, {
      authProfileId: "openai:ada",
      links: [{ provider: "openai", authProfileId: "openai:ada", updatedAt: 1 }],
    });
    // The pasted redirect carries the single-use code: redaction must precede
    // the exchange so no failure path can echo it.
    expect(registerSecretValueForRedaction).toHaveBeenCalledWith(
      "http://localhost:1455/auth/callback?code=auth-code&state=flow-state",
    );
    expect(registerSecretValueForRedaction.mock.invocationCallOrder[0]).toBeLessThan(
      exchangeOpenAIAuthorizationCode.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("rejects a redirect whose state does not match the pending flow", async () => {
    const flow = await startFlow("profile-2");

    const respond = await runHandler("users.authConnect.complete", {
      profileId: "profile-2",
      connectId: flow.connectId,
      redirectInput: "http://localhost:1455/auth/callback?code=auth-code&state=other-state",
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    expect(exchangeOpenAIAuthorizationCode).not.toHaveBeenCalled();
    expect(upsertAuthProfileAfterLoginWithLockOrThrow).not.toHaveBeenCalled();
  });

  it("treats a completed flow as single-use", async () => {
    const flow = await startFlow("profile-3");
    const redirectInput = "http://localhost:1455/auth/callback?code=auth-code&state=flow-state";
    await runHandler("users.authConnect.complete", {
      profileId: "profile-3",
      connectId: flow.connectId,
      redirectInput,
    });

    const replay = await runHandler("users.authConnect.complete", {
      profileId: "profile-3",
      connectId: flow.connectId,
      redirectInput,
    });

    expect(replay).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("expired"),
      }),
    );
    expect(exchangeOpenAIAuthorizationCode).toHaveBeenCalledTimes(1);
  });

  it("keeps exchange failures canned without leaking provider detail", async () => {
    exchangeOpenAIAuthorizationCode.mockResolvedValue({
      type: "failed",
      status: 400,
      message: "raw body with secret material",
    });
    const flow = await startFlow("profile-4");

    const respond = await runHandler("users.authConnect.complete", {
      profileId: "profile-4",
      connectId: flow.connectId,
      redirectInput: "http://localhost:1455/auth/callback?code=auth-code&state=flow-state",
    });

    const error = respond.mock.calls[0]?.[2];
    expect(error).toMatchObject({ code: "INVALID_REQUEST" });
    expect(JSON.stringify(error)).not.toContain("raw body");
    expect(upsertAuthProfileAfterLoginWithLockOrThrow).not.toHaveBeenCalled();
  });

  it("reuses the person's already linked profile id on reconnect", async () => {
    listUserProfileAuthLinks.mockReturnValue([
      { provider: "openai", authProfileId: "openai:custom", updatedAt: 1 },
    ]);
    const flow = await startFlow("profile-5");

    await runHandler("users.authConnect.complete", {
      profileId: "profile-5",
      connectId: flow.connectId,
      redirectInput: "http://localhost:1455/auth/callback?code=auth-code&state=flow-state",
    });

    expect(upsertAuthProfileAfterLoginWithLockOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: "openai:custom" }),
    );
  });

  it("suffixes the derived profile id when the slug is already taken", async () => {
    ensureAuthProfileStoreWithoutExternalProfiles.mockReturnValue({
      version: 1,
      profiles: { "openai:ada": { type: "oauth", provider: "openai" } },
    });
    const flow = await startFlow("profile-6");

    await runHandler("users.authConnect.complete", {
      profileId: "profile-6",
      connectId: flow.connectId,
      redirectInput: "http://localhost:1455/auth/callback?code=auth-code&state=flow-state",
    });

    expect(upsertAuthProfileAfterLoginWithLockOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: "openai:ada-2" }),
    );
  });

  it("stores a pasted Claude setup-token and links it", async () => {
    const respond = await runHandler("users.authConnect.token", {
      profileId: "profile-1",
      provider: "anthropic",
      token: SETUP_TOKEN,
    });

    expect(registerSecretValueForRedaction).toHaveBeenCalledWith(SETUP_TOKEN);
    expect(upsertAuthProfileWithLockOrThrow).toHaveBeenCalledWith({
      profileId: "anthropic:ada",
      credential: { type: "token", provider: "anthropic", token: SETUP_TOKEN },
    });
    expect(respond).toHaveBeenCalledWith(true, {
      authProfileId: "anthropic:ada",
      links: [{ provider: "anthropic", authProfileId: "anthropic:ada", updatedAt: 1 }],
    });
  });

  it("rejects malformed setup-tokens after redaction and before storage", async () => {
    const respond = await runHandler("users.authConnect.token", {
      profileId: "profile-1",
      provider: "anthropic",
      token: "sk-ant-oat01-short",
    });

    expect(registerSecretValueForRedaction).toHaveBeenCalledWith("sk-ant-oat01-short");
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    expect(upsertAuthProfileWithLockOrThrow).not.toHaveBeenCalled();
  });

  it("denies connecting on another person's profile without operator.admin", async () => {
    const respond = await runHandler(
      "users.authConnect.start",
      { profileId: "profile-other", provider: "openai" },
      { authenticatedUserId: "ada@example.com", connect: { scopes: ["operator.write"] } },
    );

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "FORBIDDEN" }),
    );
    expect(createOpenAIAuthorizationFlow).not.toHaveBeenCalled();
  });

  it("rejects malformed params before any effect", async () => {
    const respond = await runHandler("users.authConnect.start", {
      profileId: "profile-1",
      provider: "openai",
      unexpected: true,
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    expect(getUserProfileListItem).not.toHaveBeenCalled();
    expect(registerSecretValueForRedaction).not.toHaveBeenCalled();
  });
});

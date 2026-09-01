import { describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  authStoreMocks,
  createAuthStoreWithProfiles,
  resolveSessionAuthSelection,
  withAuthState,
} from "./session-override.test-support.js";

const resolveUserProfileAuthLinkMock = vi.hoisted(() => vi.fn());
vi.mock("../../state/user-profile-auth-links.js", () => ({
  resolveUserProfileAuthLink: resolveUserProfileAuthLinkMock,
}));

const DEFAULT_PROFILE_ID = "openai:default@example.test";
const LINKED_PROFILE_ID = "openai:alice@example.test";

function prepareTwoProfileStore(): void {
  authStoreMocks.state.hasSource = true;
  authStoreMocks.state.store = createAuthStoreWithProfiles({
    profiles: {
      [DEFAULT_PROFILE_ID]: { type: "api_key", provider: "openai", key: "sk-default" },
      [LINKED_PROFILE_ID]: { type: "api_key", provider: "openai", key: "sk-alice" },
    },
    order: { openai: [DEFAULT_PROFILE_ID, LINKED_PROFILE_ID] },
  });
}

async function selectForRequester(params: {
  agentDir: string;
  sessionEntry: SessionEntry;
  sessionStore: Record<string, SessionEntry>;
  requesterProfileId?: string;
  isNewSession?: boolean;
}) {
  return await resolveSessionAuthSelection({
    cfg: {} as OpenClawConfig,
    provider: "openai",
    modelId: "model-x",
    agentDir: params.agentDir,
    sessionEntry: params.sessionEntry,
    sessionStore: params.sessionStore,
    sessionKey: "agent:main:main",
    isNewSession: params.isNewSession ?? true,
    requesterProfileId: params.requesterProfileId,
  });
}

describe("person-linked session auth", () => {
  it("establishes a sticky user-link pin for the requester's linked profile", async () => {
    await withAuthState(async (state) => {
      prepareTwoProfileStore();
      resolveUserProfileAuthLinkMock.mockReturnValue(LINKED_PROFILE_ID);
      const sessionEntry: SessionEntry = { sessionId: "s1", updatedAt: 1 };
      const selection = await selectForRequester({
        agentDir: state.agentDir(),
        sessionEntry,
        sessionStore: { "agent:main:main": sessionEntry },
        requesterProfileId: "profile-alice",
      });
      expect(selection).toMatchObject({ profileId: LINKED_PROFILE_ID, source: "user" });
      expect(sessionEntry.authProfileOverride).toBe(LINKED_PROFILE_ID);
      expect(sessionEntry.authProfileOverrideSource).toBe("user-link");
      expect(resolveUserProfileAuthLinkMock).toHaveBeenCalledWith({
        profileId: "profile-alice",
        providers: ["openai"],
      });
    });
  });

  it("keeps default rotation when the requester has no link", async () => {
    await withAuthState(async (state) => {
      prepareTwoProfileStore();
      resolveUserProfileAuthLinkMock.mockReturnValue(undefined);
      const sessionEntry: SessionEntry = { sessionId: "s1", updatedAt: 1 };
      const selection = await selectForRequester({
        agentDir: state.agentDir(),
        sessionEntry,
        sessionStore: { "agent:main:main": sessionEntry },
        requesterProfileId: "profile-alice",
      });
      expect(selection).toMatchObject({ profileId: DEFAULT_PROFILE_ID, source: "auto" });
      expect(sessionEntry.authProfileOverrideSource).toBe("auto");
    });
  });

  it("never consults links for turns without an authenticated requester", async () => {
    await withAuthState(async (state) => {
      prepareTwoProfileStore();
      const sessionEntry: SessionEntry = { sessionId: "s1", updatedAt: 1 };
      const selection = await selectForRequester({
        agentDir: state.agentDir(),
        sessionEntry,
        sessionStore: { "agent:main:main": sessionEntry },
      });
      expect(selection).toMatchObject({ profileId: DEFAULT_PROFILE_ID, source: "auto" });
      expect(resolveUserProfileAuthLinkMock).not.toHaveBeenCalled();
    });
  });

  it("leaves explicit /model user pins untouched", async () => {
    await withAuthState(async (state) => {
      prepareTwoProfileStore();
      const sessionEntry: SessionEntry = {
        sessionId: "s1",
        updatedAt: 1,
        authProfileOverride: DEFAULT_PROFILE_ID,
        authProfileOverrideSource: "user",
      };
      const selection = await selectForRequester({
        agentDir: state.agentDir(),
        sessionEntry,
        sessionStore: { "agent:main:main": sessionEntry },
        requesterProfileId: "profile-alice",
        isNewSession: false,
      });
      expect(selection).toMatchObject({ profileId: DEFAULT_PROFILE_ID, source: "user" });
      expect(sessionEntry.authProfileOverrideSource).toBe("user");
      expect(resolveUserProfileAuthLinkMock).not.toHaveBeenCalled();
    });
  });

  it("stays pinned to the establishing person when another linked person steers later", async () => {
    await withAuthState(async (state) => {
      prepareTwoProfileStore();
      resolveUserProfileAuthLinkMock.mockReturnValue(DEFAULT_PROFILE_ID);
      const sessionEntry: SessionEntry = {
        sessionId: "s1",
        updatedAt: 1,
        authProfileOverride: LINKED_PROFILE_ID,
        authProfileOverrideSource: "user-link",
      };
      const selection = await selectForRequester({
        agentDir: state.agentDir(),
        sessionEntry,
        sessionStore: { "agent:main:main": sessionEntry },
        requesterProfileId: "profile-bob",
        isNewSession: false,
      });
      expect(selection).toMatchObject({ profileId: LINKED_PROFILE_ID, source: "user" });
      expect(sessionEntry.authProfileOverride).toBe(LINKED_PROFILE_ID);
      expect(resolveUserProfileAuthLinkMock).not.toHaveBeenCalled();
    });
  });

  it("ignores links that resolve to unknown or incompatible profiles", async () => {
    await withAuthState(async (state) => {
      prepareTwoProfileStore();
      resolveUserProfileAuthLinkMock.mockReturnValue("anthropic:alice@example.test");
      const sessionEntry: SessionEntry = { sessionId: "s1", updatedAt: 1 };
      const selection = await selectForRequester({
        agentDir: state.agentDir(),
        sessionEntry,
        sessionStore: { "agent:main:main": sessionEntry },
        requesterProfileId: "profile-alice",
      });
      expect(selection).toMatchObject({ profileId: DEFAULT_PROFILE_ID, source: "auto" });
      expect(sessionEntry.authProfileOverrideSource).toBe("auto");
    });
  });
});

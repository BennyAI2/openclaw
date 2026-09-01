// Self-service model-account OAuth connect flows bound to Gateway profiles.
import { randomUUID } from "node:crypto";
import http from "node:http";
import {
  ErrorCodes,
  errorShape,
  validateUsersAuthConnectCompleteParams,
  validateUsersAuthConnectStartParams,
  validateUsersAuthConnectTokenParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveSharedMainAuthAgentDir } from "../../agents/auth-profiles/shared-main-dir.js";
import { ensureAuthProfileStoreWithoutExternalProfiles } from "../../agents/auth-profiles/store.js";
import type { OAuthCredential, TokenCredential } from "../../agents/auth-profiles/types.js";
import {
  upsertAuthProfileAfterLoginWithLockOrThrow,
  upsertAuthProfileWithLockOrThrow,
} from "../../agents/auth-profiles/upsert-with-lock.js";
import { refreshRunningGatewayAuthState } from "../../commands/models/auth-refresh.js";
import { registerSecretValueForRedaction } from "../../logging/secret-redaction-registry.js";
import { loadActivatedBundledPluginPublicSurfaceModuleSync } from "../../plugin-sdk/facade-runtime.js";
import { resolveOpenAICodexAuthIdentity } from "../../plugin-sdk/provider-auth.js";
import { parseOAuthAuthorizationInput } from "../../plugin-sdk/provider-oauth-runtime.js";
import { validateAnthropicSetupToken } from "../../plugins/provider-auth-token.js";
import type { UserProfileAuthLink } from "../../state/user-profile-auth-links.js";
import {
  listUserProfileAuthLinks,
  setUserProfileAuthLink,
} from "../../state/user-profile-auth-links.js";
import {
  getUserProfileListItem,
  resolveUserProfileId,
  UserProfileNotFoundError,
} from "../../state/user-profiles.js";
import type { GatewayRequestHandlers } from "./types.js";
import { canMutateProfile, requireProfileMutationAccess } from "./users-profile-access.js";
import { assertValidParams } from "./validation.js";

type OpenAIConnectFacade = {
  createOpenAIAuthorizationFlow: (
    originator: string,
    redirectUri: string,
  ) => Promise<{ verifier: string; redirectUri: string; state: string; url: string }>;
  resolveOpenAICallbackHost: () => string;
  resolveOpenAIRedirectUri: (host: string) => string;
  exchangeOpenAIAuthorizationCode: (
    code: string,
    verifier: string,
    redirectUri: string,
  ) => Promise<
    | { type: "success"; access: string; refresh: string; expires: number }
    | { type: "failed"; status?: number; message: string }
  >;
};

function loadOpenAIConnectFacade(): OpenAIConnectFacade {
  return loadActivatedBundledPluginPublicSurfaceModuleSync<OpenAIConnectFacade>({
    dirName: "openai",
    artifactBasename: "api.js",
  });
}

type ConnectPerson = { id: string; displayName: string | null; emails: string[] };

type PendingConnect = {
  profileId: string;
  provider: "openai";
  person: ConnectPerson;
  verifier: string;
  state: string;
  redirectUri: string;
  expiresAtMs: number;
};

// Pending flows are process-local by design: a restart aborts them and the
// person simply restarts the connect from their profile page.
const PENDING_CONNECT_TTL_MS = 15 * 60 * 1000;
const PENDING_CONNECT_MAX = 8;
const CALLBACK_PORT = 1455;
const CALLBACK_PATH = "/auth/callback";
const pendingConnects = new Map<string, PendingConnect>();
let callbackServer: http.Server | undefined;

function sweepPendingConnects(now: number): void {
  for (const [connectId, pending] of pendingConnects) {
    if (pending.expiresAtMs <= now) {
      pendingConnects.delete(connectId);
    }
  }
  releaseCallbackListenerIfIdle();
}

function reservePendingConnect(pending: PendingConnect): string | undefined {
  const now = Date.now();
  sweepPendingConnects(now);
  for (const [connectId, existing] of pendingConnects) {
    if (existing.profileId === pending.profileId && existing.provider === pending.provider) {
      pendingConnects.delete(connectId);
    }
  }
  if (pendingConnects.size >= PENDING_CONNECT_MAX) {
    return undefined;
  }
  const connectId = randomUUID();
  pendingConnects.set(connectId, pending);
  setTimeout(() => sweepPendingConnects(Date.now()), PENDING_CONNECT_TTL_MS + 1000).unref();
  return connectId;
}

function takePendingConnectByState(state: string): PendingConnect | undefined {
  sweepPendingConnects(Date.now());
  for (const [connectId, pending] of pendingConnects) {
    if (pending.state === state) {
      pendingConnects.delete(connectId);
      return pending;
    }
  }
  return undefined;
}

function connectProfileSlug(person: ConnectPerson): string {
  const raw = person.displayName?.trim() || person.emails[0]?.split("@")[0] || "user";
  const slug = raw
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 24);
  return slug || "user";
}

/**
 * Reconnects refresh the person's linked profile only when its stored
 * credential is the same provider account (or the profile vanished): a link an
 * admin pointed at a shared or foreign credential must never be overwritten by
 * a personal reconnect. Everything else mints a unique id.
 */
function deriveConnectAuthProfileId(params: {
  provider: string;
  person: ConnectPerson;
  // Absent for setup-token connects, which carry no comparable account identity.
  accountId?: string;
}): string {
  const store = ensureAuthProfileStoreWithoutExternalProfiles(resolveSharedMainAuthAgentDir(), {
    readOnly: true,
  });
  const linked = listUserProfileAuthLinks(params.person.id).find(
    (link) => link.provider === params.provider,
  );
  if (linked) {
    const stored = store.profiles[linked.authProfileId];
    const sameAccount =
      params.accountId !== undefined &&
      stored?.type === "oauth" &&
      stored.accountId === params.accountId;
    if (!stored || sameAccount) {
      return linked.authProfileId;
    }
  }
  const base = `${params.provider}:${connectProfileSlug(params.person)}`;
  if (!store.profiles[base]) {
    return base;
  }
  for (let suffix = 2; suffix <= 99; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!store.profiles[candidate]) {
      return candidate;
    }
  }
  return `${params.provider}:${params.person.id.slice(0, 8)}`;
}

type FinishConnectResult =
  | { ok: true; authProfileId: string; links: UserProfileAuthLink[] }
  | { ok: false; reason: "exchange" | "identity" | "authority" };

/**
 * Shared exchange→persist→link path for the paste RPC and the local callback.
 * The exchange awaits external I/O, so authority is revalidated afterwards and
 * before any persistence: `revalidate` re-runs the caller's live access check
 * (the clientless loopback callback has none), and a person whose profile no
 * longer resolves fails closed on both paths.
 */
async function finishPendingConnect(
  pending: PendingConnect,
  code: string,
  revalidate?: () => boolean,
): Promise<FinishConnectResult> {
  const facade = loadOpenAIConnectFacade();
  const exchanged = await facade.exchangeOpenAIAuthorizationCode(
    code,
    pending.verifier,
    pending.redirectUri,
  );
  if (exchanged.type !== "success") {
    return { ok: false, reason: "exchange" };
  }
  const identity = resolveOpenAICodexAuthIdentity({ access: exchanged.access });
  if (!identity.accountId) {
    return { ok: false, reason: "identity" };
  }
  if (revalidate && !revalidate()) {
    return { ok: false, reason: "authority" };
  }
  if (!resolveUserProfileId(pending.person.id)) {
    return { ok: false, reason: "authority" };
  }
  const authProfileId = deriveConnectAuthProfileId({
    provider: pending.provider,
    person: pending.person,
    accountId: identity.accountId,
  });
  const credential: OAuthCredential = {
    type: "oauth",
    provider: pending.provider,
    access: exchanged.access,
    refresh: exchanged.refresh,
    expires: exchanged.expires,
    accountId: identity.accountId,
  };
  await upsertAuthProfileAfterLoginWithLockOrThrow({ profileId: authProfileId, credential });
  const links = setUserProfileAuthLink({
    profileId: pending.person.id,
    provider: pending.provider,
    authProfileId,
  });
  await refreshRunningGatewayAuthState().catch(() => {});
  return { ok: true, authProfileId, links };
}

function callbackPage(message: string): string {
  return `<!doctype html><meta charset="utf-8"><title>OpenClaw</title><body style="font-family:system-ui;margin:3rem;max-width:32rem"><p>${message}</p></body>`;
}

// The gateway may catch the loopback redirect itself so a browser on the
// gateway host completes without pasting. Remote browsers still land on their
// own dead localhost tab and use the paste path. Exported for focused tests so
// completion, state-matching, and redaction are proven without binding a port.
export async function handleConnectCallbackRequest(
  requestUrl: string,
): Promise<{ status: number; body: string }> {
  const url = new URL(requestUrl, `http://localhost:${CALLBACK_PORT}`);
  if (url.pathname !== CALLBACK_PATH) {
    return { status: 404, body: callbackPage("Not found.") };
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (code) {
    // The code is single-use secret material; never let it reach logs.
    registerSecretValueForRedaction(code);
  }
  const pending = state ? takePendingConnectByState(state) : undefined;
  if (!code || !pending) {
    return {
      status: 410,
      body: callbackPage(
        "This sign-in link is no longer active. Restart the connect from your OpenClaw profile page.",
      ),
    };
  }
  try {
    const finished = await finishPendingConnect(pending, code);
    if (!finished.ok) {
      return {
        status: 502,
        body: callbackPage(
          "OpenAI did not accept the sign-in. Return to OpenClaw and restart the connect.",
        ),
      };
    }
    return {
      status: 200,
      body: callbackPage(
        "ChatGPT account connected. You can close this tab and return to OpenClaw.",
      ),
    };
  } finally {
    releaseCallbackListenerIfIdle();
  }
}

// Resolves once the bind settles so the start reply promises auto-capture only
// when the listener truly owns the port; a busy port (e.g. a CLI login) leaves
// the paste path as the sole completion route.
async function armCallbackListener(host: string): Promise<boolean> {
  if (callbackServer) {
    return true;
  }
  const server = http.createServer((request, response) => {
    void handleConnectCallbackRequest(request.url ?? "/").then(({ status, body }) => {
      response.writeHead(status, { "content-type": "text/html; charset=utf-8" });
      response.end(body);
    });
  });
  server.unref();
  return await new Promise<boolean>((resolve) => {
    server.once("error", () => resolve(false));
    server.listen(CALLBACK_PORT, host, () => {
      callbackServer = server;
      resolve(true);
    });
  });
}

function releaseCallbackListenerIfIdle(): void {
  if (pendingConnects.size === 0 && callbackServer) {
    callbackServer.close();
    callbackServer = undefined;
  }
}

/** Test-only reset: clears pending flows and closes the callback listener. */
export function resetUsersAuthConnectForTest(): void {
  pendingConnects.clear();
  releaseCallbackListenerIfIdle();
}

function connectUnavailableError() {
  return errorShape(
    ErrorCodes.UNAVAILABLE,
    "model account connect is unavailable right now; try again shortly",
  );
}

function profileNotFoundError(error: unknown) {
  return error instanceof UserProfileNotFoundError
    ? errorShape(ErrorCodes.INVALID_REQUEST, error.message)
    : undefined;
}

export const usersAuthConnectHandlers: GatewayRequestHandlers = {
  "users.authConnect.start": async ({ client, params, respond }) => {
    if (
      !assertValidParams(
        params,
        validateUsersAuthConnectStartParams,
        "users.authConnect.start",
        respond,
      )
    ) {
      return;
    }
    try {
      if (!requireProfileMutationAccess(client, params.profileId, respond)) {
        return;
      }
      const person = getUserProfileListItem(params.profileId);
      const facade = loadOpenAIConnectFacade();
      const callbackHost = facade.resolveOpenAICallbackHost();
      const redirectUri = facade.resolveOpenAIRedirectUri(callbackHost);
      const flow = await facade.createOpenAIAuthorizationFlow("openclaw", redirectUri);
      const expiresAtMs = Date.now() + PENDING_CONNECT_TTL_MS;
      const connectId = reservePendingConnect({
        profileId: person.id,
        provider: params.provider,
        person: { id: person.id, displayName: person.displayName, emails: person.emails },
        verifier: flow.verifier,
        state: flow.state,
        redirectUri: flow.redirectUri,
        expiresAtMs,
      });
      if (!connectId) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, "too many connect flows are in progress; try again"),
        );
        return;
      }
      const autoCallback = await armCallbackListener(callbackHost);
      respond(true, { connectId, url: flow.url, expiresAtMs, autoCallback });
    } catch (error) {
      respond(false, undefined, profileNotFoundError(error) ?? connectUnavailableError());
    }
  },
  "users.authConnect.complete": async ({ client, params, respond }) => {
    if (
      !assertValidParams(
        params,
        validateUsersAuthConnectCompleteParams,
        "users.authConnect.complete",
        respond,
      )
    ) {
      return;
    }
    // Redaction precedes validation and exchange so no failure path can echo
    // the pasted redirect (it carries the single-use authorization code).
    registerSecretValueForRedaction(params.redirectInput);
    try {
      if (!requireProfileMutationAccess(client, params.profileId, respond)) {
        return;
      }
      const person = getUserProfileListItem(params.profileId);
      sweepPendingConnects(Date.now());
      const pending = pendingConnects.get(params.connectId);
      if (!pending || pending.profileId !== person.id) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "this connect flow expired or was replaced; start the connect again",
          ),
        );
        return;
      }
      const parsed = parseOAuthAuthorizationInput(params.redirectInput);
      if (!parsed.code || (parsed.state && parsed.state !== pending.state)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "that redirect did not match this connect flow; paste the full URL from the localhost tab",
          ),
        );
        return;
      }
      // The authorization code is single-use: this attempt consumes the flow.
      pendingConnects.delete(params.connectId);
      const finished = await finishPendingConnect(pending, parsed.code, () =>
        canMutateProfile(client, pending.profileId),
      );
      releaseCallbackListenerIfIdle();
      if (!finished.ok) {
        if (finished.reason === "authority") {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.FORBIDDEN, "this sign-in can no longer be completed"),
          );
          return;
        }
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            finished.reason === "identity"
              ? "OpenAI sign-in returned no account identity"
              : "OpenAI did not accept the sign-in; start the connect again and paste the fresh redirect URL",
          ),
        );
        return;
      }
      respond(true, { authProfileId: finished.authProfileId, links: finished.links });
    } catch (error) {
      respond(false, undefined, profileNotFoundError(error) ?? connectUnavailableError());
    }
  },
  "users.authConnect.token": async ({ client, params, respond }) => {
    if (
      !assertValidParams(
        params,
        validateUsersAuthConnectTokenParams,
        "users.authConnect.token",
        respond,
      )
    ) {
      return;
    }
    // Redaction precedes validation so a rejected paste can never be echoed.
    registerSecretValueForRedaction(params.token);
    try {
      if (!requireProfileMutationAccess(client, params.profileId, respond)) {
        return;
      }
      const person = getUserProfileListItem(params.profileId);
      const token = params.token.trim();
      const invalidReason = validateAnthropicSetupToken(token);
      if (invalidReason) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, invalidReason));
        return;
      }
      const authProfileId = deriveConnectAuthProfileId({
        provider: params.provider,
        person: { id: person.id, displayName: person.displayName, emails: person.emails },
      });
      const credential: TokenCredential = { type: "token", provider: params.provider, token };
      await upsertAuthProfileWithLockOrThrow({ profileId: authProfileId, credential });
      const links = setUserProfileAuthLink({
        profileId: person.id,
        provider: params.provider,
        authProfileId,
      });
      await refreshRunningGatewayAuthState().catch(() => {});
      respond(true, { authProfileId, links });
    } catch (error) {
      respond(false, undefined, profileNotFoundError(error) ?? connectUnavailableError());
    }
  },
};

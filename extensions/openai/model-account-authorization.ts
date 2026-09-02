import {
  decodeOpenAICodexJwtPayload,
  resolveOpenAICodexAuthIdentity,
  type AuthProfileStore,
  type OAuthCredential,
} from "openclaw/plugin-sdk/provider-auth";
import {
  asNonArrayRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  createOpenAIAuthorizationFlow,
  resolveOpenAICallbackHost,
  resolveOpenAIRedirectUri,
} from "./openai-chatgpt-oauth-authorization.runtime.js";
import { exchangeOpenAIAuthorizationCode } from "./openai-chatgpt-oauth-token.runtime.js";

type AuthorizationResult =
  | {
      status: "authorized";
      credential: OAuthCredential;
      matchesCredential: (existing: AuthProfileStore["profiles"][string]) => boolean;
    }
  | { status: "failed"; reason: "exchange" | "identity" };

function accountSubject(access: string): { accountId: string; userId: string } | undefined {
  const claims = asNonArrayRecord(
    decodeOpenAICodexJwtPayload(access)?.["https://api.openai.com/auth"],
  );
  const accountId = normalizeOptionalString(claims.chatgpt_account_id);
  const userId =
    normalizeOptionalString(claims.chatgpt_user_id) ?? normalizeOptionalString(claims.user_id);
  return accountId && userId ? { accountId, userId } : undefined;
}

/** Provider-owned PKCE and account identity; the Gateway owns operation lifetime and storage. */
export async function createModelAccountAuthorization() {
  const redirectUri = resolveOpenAIRedirectUri(resolveOpenAICallbackHost());
  const flow = await createOpenAIAuthorizationFlow("openclaw", redirectUri);
  return {
    url: flow.url,
    state: flow.state,
    redirectUri: flow.redirectUri,
    async exchange(code: string, signal: AbortSignal): Promise<AuthorizationResult> {
      const tokens = await exchangeOpenAIAuthorizationCode(code, flow.verifier, flow.redirectUri, {
        signal,
      });
      if (tokens.type !== "success") {
        return { status: "failed", reason: "exchange" };
      }
      const identity = resolveOpenAICodexAuthIdentity({ access: tokens.access });
      if (!identity.accountId) {
        return { status: "failed", reason: "identity" };
      }
      const subject = accountSubject(tokens.access);
      const credential: OAuthCredential = {
        type: "oauth",
        provider: "openai",
        access: tokens.access,
        refresh: tokens.refresh,
        expires: tokens.expires,
        accountId: identity.accountId,
        ...(identity.email ? { email: identity.email } : {}),
        ...(identity.chatgptPlanType ? { chatgptPlanType: identity.chatgptPlanType } : {}),
      };
      return {
        status: "authorized",
        credential,
        // Codex's chatgpt_account_id is a workspace, not a person. Replacing an
        // owned credential also requires its exact user; missing claims mint a new slot.
        matchesCredential: (existing) => {
          if (!subject || existing.type !== "oauth" || existing.provider !== credential.provider) {
            return false;
          }
          const previous = accountSubject(existing.access);
          return previous?.accountId === subject.accountId && previous.userId === subject.userId;
        },
      };
    },
  };
}

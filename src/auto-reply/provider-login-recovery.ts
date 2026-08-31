import type { OAuthRefreshFailureReason } from "../agents/auth-profiles/oauth-refresh-failure.js";
import type { FailoverReason } from "../agents/failover/signal.js";
import type { MessagePresentation } from "../interactive/payload.js";
import { resolveProviderChannelLoginChoice } from "../plugins/provider-login-options.js";

export type ProviderLoginRecoveryEvidence = {
  provider?: string | null;
  oauthReason?: OAuthRefreshFailureReason | null;
  failoverReason?: FailoverReason;
  authMode?: string;
};

export type ProviderLoginRecovery = {
  hint: string;
  presentation: MessagePresentation;
};

const AUTH_PROFILE_LOGIN_REASONS = new Set<FailoverReason>([
  "auth",
  "auth_permanent",
  "session_expired",
]);

/** Build an actionable login only from OAuth failure evidence and a trusted channel choice. */
export function buildProviderLoginRecovery(
  evidence: ProviderLoginRecoveryEvidence,
): ProviderLoginRecovery | undefined {
  const needsLogin =
    evidence.oauthReason !== null && evidence.oauthReason !== undefined
      ? true
      : evidence.authMode === "oauth" &&
        evidence.failoverReason !== undefined &&
        AUTH_PROFILE_LOGIN_REASONS.has(evidence.failoverReason);
  if (!needsLogin) {
    return undefined;
  }
  const resolution = resolveProviderChannelLoginChoice(evidence.provider ?? undefined);
  if (resolution.status !== "resolved") {
    return undefined;
  }
  const { choice } = resolution;
  const command = `/login ${choice.command}`;
  const actionLabel = `Sign in to ${choice.providerLabel}`;
  return {
    hint: `${choice.providerLabel} needs a new login. Send \`${command}\` from a private chat or Control UI session. Where shown, you can also select **${actionLabel}**.`,
    presentation: {
      blocks: [
        {
          type: "buttons",
          buttons: [
            {
              label: actionLabel,
              action: { type: "command", command },
            },
          ],
        },
      ],
    },
  };
}

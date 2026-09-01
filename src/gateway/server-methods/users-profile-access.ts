// Shared self-or-admin mutation policy for durable user profile methods.
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { ensureProfileForEmail, resolveUserProfileId } from "../../state/user-profiles.js";
import { ADMIN_SCOPE } from "../operator-scopes.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

export function resolveAuthenticatedProfileId(
  client: GatewayRequestHandlerOptions["client"],
): string | undefined {
  if (client?.authenticatedUserProfile?.profileId) {
    return resolveUserProfileId(client.authenticatedUserProfile.profileId);
  }
  if (client?.authenticatedGitHubIdentitySync) {
    return undefined;
  }
  const authenticatedUserId = client?.authenticatedUserId;
  if (!authenticatedUserId) {
    return undefined;
  }
  // A failed Tailscale profile snapshot must not recreate its provider login
  // through the legacy email resolver on a later self-profile request.
  if (client.authenticatedUserIsTailscaleProvider) {
    return undefined;
  }
  return ensureProfileForEmail(authenticatedUserId).id;
}

export function canMutateProfile(
  client: GatewayRequestHandlerOptions["client"],
  profileId: string,
): boolean {
  if (client?.connect.scopes?.includes(ADMIN_SCOPE)) {
    return true;
  }
  const authenticatedProfileId = resolveAuthenticatedProfileId(client);
  return (
    authenticatedProfileId !== undefined &&
    authenticatedProfileId === resolveUserProfileId(profileId)
  );
}

/**
 * Attaching an existing stored credential to a person is admin-only: profile
 * ownership is not credential ownership, and a linked id becomes both a strict
 * billing pin and the reconnect refresh target for that person's sessions.
 * Self-service stays on the connect flows, which prove account control.
 */
export function requireAdminProfileAccess(
  client: GatewayRequestHandlerOptions["client"],
  respond: GatewayRequestHandlerOptions["respond"],
): boolean {
  if (client?.connect.scopes?.includes(ADMIN_SCOPE)) {
    return true;
  }
  respond(
    false,
    undefined,
    errorShape(
      ErrorCodes.FORBIDDEN,
      "linking an existing auth profile requires operator.admin; connect your own account from the profile page instead",
    ),
  );
  return false;
}

export function requireProfileMutationAccess(
  client: GatewayRequestHandlerOptions["client"],
  profileId: string,
  respond: GatewayRequestHandlerOptions["respond"],
): boolean {
  // These methods are write-scoped so an identified caller can edit only its own profile;
  // edits targeting any other profile remain admin-only.
  if (canMutateProfile(client, profileId)) {
    return true;
  }
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.FORBIDDEN, "profile edits require the owning user or operator.admin"),
  );
  return false;
}

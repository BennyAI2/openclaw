import {
  ErrorCodes,
  errorShape,
  validateUsersAuthConnectCancelParams,
  validateUsersAuthConnectCompleteParams,
  validateUsersAuthConnectStartParams,
  validateUsersAuthConnectStatusParams,
  validateUsersAuthConnectTokenParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { getGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { registerSecretValueForRedaction } from "../../logging/secret-redaction-registry.js";
import { validateAnthropicSetupToken } from "../../plugins/provider-auth-token.js";
import { roleScopesAllow } from "../../shared/operator-scope-compat.js";
import {
  getUserProfileListItem,
  resolveUserProfileId,
  UserProfileNotFoundError,
} from "../../state/user-profiles.js";
import {
  ModelAccountConnectAuthorityError,
  ModelAccountConnectInputError,
  type ModelAccountConnectAction,
} from "../model-account-connect.js";
import { resolveOperatorRolePolicyForProfile } from "../operator-role-policy.js";
import { isGatewayClientProfilePending } from "./gateway-client-identity.js";
import type {
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
  GatewayRequestHandlers,
} from "./types.js";
import { resolveAuthenticatedProfileId } from "./users-profile-access.js";
import { defineValidatedGatewayMethod } from "./validation.js";

type ConnectRequest = Pick<
  GatewayRequestHandlerOptions,
  "client" | "context" | "signal" | "respond"
>;

function prepareConnectAction(
  options: ConnectRequest,
  profileId: string,
): ModelAccountConnectAction {
  const { client, context } = options;
  const owner = getUserProfileListItem(profileId).id;
  const actor = resolveAuthenticatedProfileId(client);
  const assertCurrent = () => {
    // Bind to the exact initiating socket, not retained scopes or a copied id.
    // Disconnect and role invalidation both retire this pending authorization.
    if (
      !client?.connId ||
      client.connect.role !== "operator" ||
      client.internal?.syntheticClient ||
      client.internal?.agentToolCaller ||
      client.internal?.agentRuntimeIdentity ||
      client.internal?.operatorRoleActor ||
      getGatewayToolCallerIdentity() ||
      options.signal?.aborted ||
      isGatewayClientProfilePending(client) ||
      !context.getClientConnIds?.((current) => current === client).has(client.connId) ||
      resolveUserProfileId(owner) !== owner ||
      resolveAuthenticatedProfileId(client) !== actor
    ) {
      throw new ModelAccountConnectAuthorityError();
    }
    const scope = actor === owner ? "operator.write" : "operator.admin";
    const role = resolveOperatorRolePolicyForProfile(actor, context.getRuntimeConfig());
    const grants = [client.connect.scopes ?? [], ...(role ? [role.scopes] : [])];
    if (
      !grants.every((allowedScopes) =>
        roleScopesAllow({ role: "operator", requestedScopes: [scope], allowedScopes }),
      )
    ) {
      throw new ModelAccountConnectAuthorityError();
    }
  };
  assertCurrent();
  return { owner, assertCurrent };
}

function runConnectRequest(
  options: ConnectRequest,
  profileId: string,
  run: (
    service: NonNullable<GatewayRequestContext["modelAccountConnectService"]>,
    action: ModelAccountConnectAction,
  ) => unknown,
): void | Promise<void> {
  const fail = (error: unknown) => {
    const responseError =
      error instanceof ModelAccountConnectAuthorityError
        ? errorShape(ErrorCodes.FORBIDDEN, error.message)
        : error instanceof ModelAccountConnectInputError ||
            error instanceof UserProfileNotFoundError
          ? errorShape(ErrorCodes.INVALID_REQUEST, error.message)
          : errorShape(
              ErrorCodes.UNAVAILABLE,
              "Model account connect is unavailable right now; try again shortly.",
            );
    options.respond(false, undefined, responseError);
  };
  try {
    const action = prepareConnectAction(options, profileId);
    const service = options.context.modelAccountConnectService;
    if (!service) {
      throw new Error("Model-account service is not running.");
    }
    const result = run(service, action);
    if (result instanceof Promise) {
      return result.then((value) => options.respond(true, value)).catch(fail);
    }
    options.respond(true, result);
  } catch (error) {
    fail(error);
  }
}

export const usersAuthConnectHandlers: GatewayRequestHandlers = {
  "users.authConnect.start": defineValidatedGatewayMethod(
    "users.authConnect.start",
    validateUsersAuthConnectStartParams,
    (options) =>
      runConnectRequest(options, options.params.profileId, (service, action) =>
        service.start(action, options.params.provider),
      ),
  ),
  "users.authConnect.complete": defineValidatedGatewayMethod(
    "users.authConnect.complete",
    validateUsersAuthConnectCompleteParams,
    (options) => {
      registerSecretValueForRedaction(options.params.redirectInput);
      return runConnectRequest(options, options.params.profileId, (service, action) =>
        service.complete(action, options.params.connectId, options.params.redirectInput),
      );
    },
  ),
  "users.authConnect.status": defineValidatedGatewayMethod(
    "users.authConnect.status",
    validateUsersAuthConnectStatusParams,
    (options) =>
      runConnectRequest(options, options.params.profileId, (service, action) =>
        service.status(action, options.params.connectId),
      ),
  ),
  "users.authConnect.cancel": defineValidatedGatewayMethod(
    "users.authConnect.cancel",
    validateUsersAuthConnectCancelParams,
    (options) =>
      runConnectRequest(options, options.params.profileId, (service, action) =>
        service.cancel(action, options.params.connectId),
      ),
  ),
  "users.authConnect.token": defineValidatedGatewayMethod(
    "users.authConnect.token",
    validateUsersAuthConnectTokenParams,
    (options) => {
      registerSecretValueForRedaction(options.params.token);
      return runConnectRequest(options, options.params.profileId, (service, action) => {
        const token = options.params.token.trim();
        const invalidReason = validateAnthropicSetupToken(token);
        if (invalidReason) {
          throw new ModelAccountConnectInputError(invalidReason);
        }
        return service.token(action, { type: "token", provider: options.params.provider, token });
      });
    },
  ),
};

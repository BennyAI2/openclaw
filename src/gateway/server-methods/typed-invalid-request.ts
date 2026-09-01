import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
} from "../../../packages/gateway-protocol/src/index.js";

export function typedInvalidRequest(
  type: string,
  message: string,
  details?: Record<string, unknown>,
): ErrorShape {
  return errorShape(ErrorCodes.INVALID_REQUEST, message, {
    details: {
      type,
      ...details,
    },
  });
}

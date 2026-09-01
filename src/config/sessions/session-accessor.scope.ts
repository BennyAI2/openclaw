import type { SessionAccessScope } from "./session-accessor.types.js";

type SessionAccessScopeInput = Pick<
  SessionAccessScope,
  "agentId" | "env" | "hydrateSkillPromptRefs" | "readConsistency" | "sessionKey" | "storePath"
>;

export function toSessionAccessScope(params: SessionAccessScopeInput): SessionAccessScope {
  // Keep caller-facing read options separate from accessor-only controls so
  // new internal fields cannot leak across this owner boundary automatically.
  return {
    sessionKey: params.sessionKey,
    ...(params.agentId !== undefined ? { agentId: params.agentId } : {}),
    ...(params.env !== undefined ? { env: params.env } : {}),
    ...(params.hydrateSkillPromptRefs !== undefined
      ? { hydrateSkillPromptRefs: params.hydrateSkillPromptRefs }
      : {}),
    ...(params.readConsistency !== undefined ? { readConsistency: params.readConsistency } : {}),
    ...(params.storePath !== undefined ? { storePath: params.storePath } : {}),
  };
}

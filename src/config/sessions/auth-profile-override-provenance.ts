import type { SessionEntry } from "./types.js";
type AuthProfileOverrideProvenance = Pick<
  SessionEntry,
  "authProfileOverride" | "authProfileOverrideSource" | "authProfileOverrideCompactionCount"
>;

export function resolveSessionAuthProfileOverrideSource(
  entry: AuthProfileOverrideProvenance | undefined,
): "auto" | "user" | "user-link" | undefined {
  if (!entry?.authProfileOverride?.trim()) {
    return undefined;
  }
  const isAutomatic = typeof entry.authProfileOverrideCompactionCount === "number";
  return entry.authProfileOverrideSource || (isAutomatic ? "auto" : "user");
}

/**
 * "user-link" exists only as persisted session provenance. Runtime consumers
 * (queued followups, compaction, CLI forwarding) see person-linked pins at
 * user-pin strength so pinned-profile fail-closed rules keep applying.
 */
function collapseSessionAuthProfilePinSource(
  source: "auto" | "user" | "user-link" | undefined,
): "auto" | "user" | undefined {
  return source === "user-link" ? "user" : source;
}

/** Runtime view of a session's pin provenance: person-linked pins read as user pins. */
export function resolveCollapsedSessionAuthPinSource(
  entry: AuthProfileOverrideProvenance | undefined,
): "auto" | "user" | undefined {
  return collapseSessionAuthProfilePinSource(resolveSessionAuthProfileOverrideSource(entry));
}

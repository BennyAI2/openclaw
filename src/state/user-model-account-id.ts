/** Personal credentials never belong in a shared auth store, even when a locator is malformed. */
export function isUserModelAuthProfileId(authProfileId: string): boolean {
  return authProfileId.startsWith("personal:");
}

/** A storage locator only; the live owner and exact credential still need to exist. */
export function parseUserModelAuthProfileId(
  authProfileId: string,
): { ownerProfileId: string } | undefined {
  const ownerProfileId = /^personal:([a-f0-9-]{36}):[a-f0-9-]{36}$/u.exec(authProfileId)?.[1];
  return ownerProfileId ? { ownerProfileId } : undefined;
}

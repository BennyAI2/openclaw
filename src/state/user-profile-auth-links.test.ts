import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";
import {
  clearUserProfileAuthLink,
  listUserProfileAuthLinks,
  resolveUserProfileAuthLink,
  setUserProfileAuthLink,
} from "./user-profile-auth-links.js";
import { ensureProfileForEmail, linkEmail } from "./user-profiles.js";

function stateOptions() {
  const directory = mkdtempSync(join(tmpdir(), "openclaw-user-profile-auth-links-"));
  const path = join(directory, "openclaw.sqlite");
  return { path };
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

describe("user profile auth links", () => {
  it("links, replaces per provider, and unlinks", () => {
    const options = stateOptions();
    const profile = ensureProfileForEmail("alice@example.test", options);
    expect(
      setUserProfileAuthLink(
        { profileId: profile.id, provider: "openai", authProfileId: "openai:alice" },
        options,
      ),
    ).toMatchObject([{ provider: "openai", authProfileId: "openai:alice" }]);
    const replaced = setUserProfileAuthLink(
      { profileId: profile.id, provider: "openai", authProfileId: "openai:alice-work" },
      options,
    );
    expect(replaced).toMatchObject([{ provider: "openai", authProfileId: "openai:alice-work" }]);
    const twoProviders = setUserProfileAuthLink(
      { profileId: profile.id, provider: "anthropic", authProfileId: "anthropic:alice" },
      options,
    );
    expect(twoProviders.map((link) => link.provider)).toEqual(["anthropic", "openai"]);
    expect(
      clearUserProfileAuthLink({ profileId: profile.id, provider: "openai" }, options),
    ).toMatchObject([{ provider: "anthropic", authProfileId: "anthropic:alice" }]);
    expect(listUserProfileAuthLinks(profile.id, options)).toHaveLength(1);
  });

  it("rejects links for unknown profiles", () => {
    const options = stateOptions();
    expect(() =>
      setUserProfileAuthLink(
        { profileId: "missing", provider: "openai", authProfileId: "openai:x" },
        options,
      ),
    ).toThrow("user profile not found");
  });

  it("resolves through provider preference order without creating storage", () => {
    const options = stateOptions();
    const profile = ensureProfileForEmail("bob@example.test", options);
    expect(
      resolveUserProfileAuthLink({ profileId: profile.id, providers: ["openai"] }, options),
    ).toBeUndefined();
    // The miss above must not have materialized the link table.
    expect(tableExists(openOpenClawStateDatabase(options).db, "user_profile_auth_links")).toBe(
      false,
    );
    setUserProfileAuthLink(
      { profileId: profile.id, provider: "openai", authProfileId: "openai:bob" },
      options,
    );
    setUserProfileAuthLink(
      { profileId: profile.id, provider: "anthropic", authProfileId: "anthropic:bob" },
      options,
    );
    expect(
      resolveUserProfileAuthLink(
        { profileId: profile.id, providers: ["anthropic", "openai"] },
        options,
      ),
    ).toBe("anthropic:bob");
    expect(
      resolveUserProfileAuthLink({ profileId: profile.id, providers: ["openai"] }, options),
    ).toBe("openai:bob");
    expect(
      resolveUserProfileAuthLink({ profileId: profile.id, providers: ["mistral"] }, options),
    ).toBeUndefined();
  });

  it("returns undefined when the state database does not exist", () => {
    const options = stateOptions();
    expect(
      resolveUserProfileAuthLink({ profileId: "anyone", providers: ["openai"] }, options),
    ).toBeUndefined();
    expect(existsSync(options.path)).toBe(false);
  });

  it("follows profile merges: target links win, source links backfill", () => {
    const options = stateOptions();
    const source = ensureProfileForEmail("carol-old@example.test", options);
    const target = ensureProfileForEmail("carol@example.test", options);
    setUserProfileAuthLink(
      { profileId: source.id, provider: "openai", authProfileId: "openai:carol-old" },
      options,
    );
    setUserProfileAuthLink(
      { profileId: source.id, provider: "anthropic", authProfileId: "anthropic:carol" },
      options,
    );
    setUserProfileAuthLink(
      { profileId: target.id, provider: "openai", authProfileId: "openai:carol" },
      options,
    );
    // Merging the source into the target repoints the alias and its links.
    linkEmail("carol-old@example.test", target.id, options);
    const links = listUserProfileAuthLinks(target.id, options);
    expect(links).toMatchObject([
      { provider: "anthropic", authProfileId: "anthropic:carol" },
      { provider: "openai", authProfileId: "openai:carol" },
    ]);
    // The merged source id resolves to the target's links.
    expect(
      resolveUserProfileAuthLink({ profileId: source.id, providers: ["openai"] }, options),
    ).toBe("openai:carol");
  });
});

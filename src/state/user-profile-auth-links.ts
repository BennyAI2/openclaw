import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "./openclaw-state-db-readonly.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";
import {
  requireResolvedUserProfileById,
  selectResolvedUserProfileById,
} from "./user-profiles-internal.js";
import { ensureUserProfilesSchema } from "./user-profiles-schema.js";

// Canonical additive schema for person-linked model auth profiles. Kept
// feature-local so shared-state opens do not create link storage until a
// person actually links an account.
const USER_PROFILE_AUTH_LINKS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS user_profile_auth_links (
  profile_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  auth_profile_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, provider)
) STRICT;
`;

type UserProfileAuthLinksDatabase = {
  user_profile_auth_links: {
    profile_id: string;
    provider: string;
    auth_profile_id: string;
    created_at: number;
    updated_at: number;
  };
};

/** One person-linked auth profile, keyed by provider on the owning profile. */
export type UserProfileAuthLink = {
  provider: string;
  authProfileId: string;
  updatedAt: number;
};

function authLinksDb(db: DatabaseSync) {
  return getNodeSqliteKysely<UserProfileAuthLinksDatabase>(db);
}

const ensuredDatabases = new WeakSet<DatabaseSync>();

/** Creates the link table on first use; ordinary shared-state opens never do. */
function ensureUserProfileAuthLinksSchema(
  options: OpenClawStateDatabaseOptions,
  database = openOpenClawStateDatabase(options),
): void {
  if (ensuredDatabases.has(database.db)) {
    return;
  }
  ensureUserProfilesSchema(options, database);
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      // sqlite-allow-raw -- Canonical feature-local additive DDL.
      db.exec(USER_PROFILE_AUTH_LINKS_SCHEMA_SQL);
    },
    { ...options, database },
    { operationLabel: "user-profile-auth-links.schema.ensure" },
  );
  // Cache only after commit; a rolled-back ensure must retry, not cache a
  // missing table.
  ensuredDatabases.add(database.db);
}

function selectProfileAuthLinks(db: DatabaseSync, profileId: string): UserProfileAuthLink[] {
  return executeSqliteQuerySync(
    db,
    authLinksDb(db)
      .selectFrom("user_profile_auth_links")
      .select(["provider", "auth_profile_id", "updated_at"])
      .where("profile_id", "=", profileId)
      .orderBy("provider", "asc"),
  ).rows.map((row) => ({
    provider: row.provider,
    authProfileId: row.auth_profile_id,
    updatedAt: row.updated_at,
  }));
}

/** Links a person to the auth profile that pays for sessions they start. */
export function setUserProfileAuthLink(
  params: { profileId: string; provider: string; authProfileId: string },
  options: OpenClawStateDatabaseOptions = {},
): UserProfileAuthLink[] {
  const database = openOpenClawStateDatabase(options);
  ensureUserProfileAuthLinksSchema(options, database);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const profileId = requireResolvedUserProfileById(db, params.profileId).id;
      const now = Date.now();
      executeSqliteQuerySync(
        db,
        authLinksDb(db)
          .insertInto("user_profile_auth_links")
          .values({
            profile_id: profileId,
            provider: params.provider,
            auth_profile_id: params.authProfileId,
            created_at: now,
            updated_at: now,
          })
          .onConflict((conflict) =>
            conflict
              .columns(["profile_id", "provider"])
              .doUpdateSet({ auth_profile_id: params.authProfileId, updated_at: now }),
          ),
      );
      return selectProfileAuthLinks(db, profileId);
    },
    { ...options, database },
    { operationLabel: "user-profile-auth-links.set" },
  );
}

/** Removes a person's link for one provider; future sessions fall back to defaults. */
export function clearUserProfileAuthLink(
  params: { profileId: string; provider: string },
  options: OpenClawStateDatabaseOptions = {},
): UserProfileAuthLink[] {
  const database = openOpenClawStateDatabase(options);
  ensureUserProfileAuthLinksSchema(options, database);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const profileId = requireResolvedUserProfileById(db, params.profileId).id;
      executeSqliteQuerySync(
        db,
        authLinksDb(db)
          .deleteFrom("user_profile_auth_links")
          .where("profile_id", "=", profileId)
          .where("provider", "=", params.provider),
      );
      return selectProfileAuthLinks(db, profileId);
    },
    { ...options, database },
    { operationLabel: "user-profile-auth-links.clear" },
  );
}

/** Reads a person's links through the profile merge head. */
export function listUserProfileAuthLinks(
  profileId: string,
  options: OpenClawStateDatabaseOptions = {},
): UserProfileAuthLink[] {
  const database = openOpenClawStateDatabase(options);
  ensureUserProfileAuthLinksSchema(options, database);
  return selectProfileAuthLinks(
    database.db,
    requireResolvedUserProfileById(database.db, profileId).id,
  );
}

/**
 * Resolves the auth profile a requester's turn should pin, preferring the
 * caller's provider order. Absent storage stays absent: this read never
 * creates link tables and returns undefined on a gateway that has no links.
 */
export function resolveUserProfileAuthLink(
  params: { profileId: string; providers: readonly string[] },
  options: OpenClawStateDatabaseOptions = {},
): string | undefined {
  if (!params.profileId || params.providers.length === 0) {
    return undefined;
  }
  return withExistingOpenClawStateDatabaseReadOnly(({ db }) => {
    if (!tableExists(db, "user_profile_auth_links")) {
      return undefined;
    }
    const profileId = tableExists(db, "user_profiles")
      ? (selectResolvedUserProfileById(db, params.profileId)?.id ?? params.profileId)
      : params.profileId;
    const byProvider = new Map(
      selectProfileAuthLinks(db, profileId).map((link) => [link.provider, link.authProfileId]),
    );
    for (const provider of params.providers) {
      const authProfileId = byProvider.get(provider);
      if (authProfileId) {
        return authProfileId;
      }
    }
    return undefined;
  }, options);
}

/** Merge hook: moves source links to the target; existing target links win. */
export function mergeUserProfileAuthLinks(
  db: DatabaseSync,
  sourceProfileIds: readonly string[],
  targetProfileId: string,
): void {
  if (sourceProfileIds.length === 0 || !tableExists(db, "user_profile_auth_links")) {
    return;
  }
  const kysely = authLinksDb(db);
  const sourceRows = executeSqliteQuerySync(
    db,
    kysely
      .selectFrom("user_profile_auth_links")
      .selectAll()
      .where("profile_id", "in", [...sourceProfileIds])
      .orderBy("updated_at", "desc"),
  ).rows;
  if (sourceRows.length === 0) {
    return;
  }
  executeSqliteQuerySync(
    db,
    kysely.deleteFrom("user_profile_auth_links").where("profile_id", "in", [...sourceProfileIds]),
  );
  // Several tombstones can carry the same provider; the newest source link
  // fills each provider the target does not already own.
  const adopted = new Set<string>();
  for (const row of sourceRows) {
    if (adopted.has(row.provider)) {
      continue;
    }
    adopted.add(row.provider);
    executeSqliteQuerySync(
      db,
      kysely
        .insertInto("user_profile_auth_links")
        .values({ ...row, profile_id: targetProfileId })
        .onConflict((conflict) => conflict.columns(["profile_id", "provider"]).doNothing()),
    );
  }
}

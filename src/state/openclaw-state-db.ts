// OpenClaw state database manages shared persisted state and migrations.
import { existsSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  clearNodeSqliteKyselyCacheForDatabase,
  executeSqliteQuerySync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import {
  normalizeSqliteNonNegativeInteger,
  readSqliteBusyTimeout,
  runWithSqliteBusyTimeout,
  setSqliteBusyTimeout,
  type SqliteLockFailureReporting,
} from "../infra/sqlite-busy-timeout.js";
import { createSqliteLifecycleAggregateError } from "../infra/sqlite-coordinator.js";
import {
  repairCanonicalSqliteIndexes,
  verifyAndRepairCanonicalSqliteIndexes,
} from "../infra/sqlite-index-schema.js";
import {
  assertSqliteIntegrity,
  confirmSqliteFileIntegrity,
  type SqliteIntegrityConfirmation,
} from "../infra/sqlite-integrity.js";
import { withSqlitePostCommitPublications } from "../infra/sqlite-post-commit.js";
import { prepareSqliteReadOnlyLocation } from "../infra/sqlite-readonly-location.js";
import { migrateSqliteSchemaToStrictInTransaction } from "../infra/sqlite-strict.js";
import {
  runSqliteImmediateTransactionSync,
  type SqliteTransactionOptions,
} from "../infra/sqlite-transaction.js";
import { readSqliteUserVersion } from "../infra/sqlite-user-version.js";
import { withStateSchemaFence } from "../infra/state-database-coordinator.js";
import { migrateLegacyCronRunLogsToTaskRuns } from "../infra/state-migrations.cron-run-logs.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { VERSION } from "../version.js";
import {
  openClawStateDatabaseCache as stateDbCache,
  recordOpenClawStateDatabaseOpenFailure,
  closeOpenClawStateDatabaseByPath,
} from "./openclaw-state-db-cache.js";
import {
  OPENCLAW_DATABASE_SCHEMA_DOCS_URL,
  OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
  OPENCLAW_STATE_SCHEMA_VERSION,
  OPENCLAW_STATE_STRICT_SCHEMA_VERSION,
  type OpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db-contract.js";
import {
  assertCurrentStateRuntimeSchema,
  isOpenClawStateSchemaFastPathEligible,
} from "./openclaw-state-db-fast-path.js";
import {
  assertOpenClawStateDatabaseForMaintenance,
  assertSupportedSchemaVersion,
  migrateConversationBindingTargets,
  migrateCronCreatorNamespaces,
  openClawStateMigrationAssertions,
  resolveDatabasePath,
} from "./openclaw-state-db-maintenance.js";
import { openUnpublishedStateDatabase } from "./openclaw-state-db-open.js";
import { ensureOpenClawStatePermissions } from "./openclaw-state-db-permissions.js";
import {
  ensureAdditiveStateColumns,
  ensureFirstUseAdditiveStateColumnsForStrictMigration,
} from "./openclaw-state-db-schema-additive.js";
import {
  type AgentDatabasePathMigrationSummary as AgentPathSummary,
  assertCanonicalStateSchemaShape,
  dropLegacyStateTables,
  migrateAgentDatabaseRelativePaths as migrateAgentPaths,
  migrateWorkerPlacementExecutionModeSchema,
  repairLegacyGatewayRestartHandoffsForStrictMigration,
} from "./openclaw-state-db-schema-repair.js";
import { migrateSingletonStateFoldInV12 } from "./openclaw-state-db-schema-v12-foldin.js";
import { migrateJsonCanonicalWideRowsV13 } from "./openclaw-state-db-schema-v13-widerow.js";
import * as sessionWatchMigration from "./openclaw-state-db-session-watch-migration.js";
import {
  initializeNativeOpenClawStateConnection,
  isUninitializedNativeStartupDatabase,
  withOpenClawStateStartupCheckpointConnection,
} from "./openclaw-state-db-startup-checkpoint.js";
import * as retirements from "./openclaw-state-db-table-retirements.js";
import type { DB as OpenClawStateKyselyDatabase } from "./openclaw-state-db.generated.js";
import { warnAgentPathMigration } from "./openclaw-state-db.paths.js";
import {
  assertOpenClawStateWriteAllowed,
  isOpenClawStateWriteContentionError,
  runWithOpenClawStateWriteAccess,
} from "./openclaw-state-ownership.js";
import {
  assertPreMigrationSourceVersion,
  createPreMigrationStateBackup,
  PRE_MIGRATION_BACKUP_RETENTION,
  type PreMigrationBackupResult,
  prunePreMigrationStateBackups,
} from "./openclaw-state-pre-migration-backup.js";
import { getOpenClawStateRuntimeSchema } from "./openclaw-state-schema-compatibility.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";
export { registerOpenClawStateDatabaseLifecycleListener } from "./openclaw-state-db-cache.js";

export { OPENCLAW_DATABASE_SCHEMA_DOCS_URL, OPENCLAW_SQLITE_BUSY_TIMEOUT_MS };
export type {
  OpenClawStateDatabase,
  OpenClawStateDatabaseOptions,
  OpenClawStateDatabaseSchemaMigration,
} from "./openclaw-state-db-contract.js";
export {
  assertOpenClawStateDatabaseForMaintenance,
  createOpenClawDatabaseVerificationError,
} from "./openclaw-state-db-maintenance.js";
export { ensureOpenClawStatePermissions } from "./openclaw-state-db-permissions.js";
export { detectOpenClawStateDatabaseSchemaMigrations } from "./openclaw-state-db-schema-repair.js";
export {
  repairOpenClawStateDatabaseSchema,
  repairOpenClawStateDatabaseSchemaIfNeeded,
} from "./openclaw-state-db-doctor-repair.js";

/** Reconfirm an advisory worker failure on the live owner connection. */
export function confirmOpenClawStateDatabaseIntegrity(
  pathname: string,
): SqliteIntegrityConfirmation {
  const resolvedPath = path.resolve(pathname);
  closeOpenClawStateDatabaseByPath(resolvedPath);
  return confirmSqliteFileIntegrity(resolvedPath, resolvedPath);
}

/** Reject a fresh shared-state open after known corruption until repair clears it. */
function assertOpenClawStateDatabaseFreshOpenAllowed(
  options: OpenClawStateDatabaseOptions = {},
): void {
  const env = options.env ?? process.env;
  stateDbCache.assertOpenClawStateDatabaseFreshOpenAllowedAtPath(resolveDatabasePath(options), env);
}

type OpenClawStateMetadataDatabase = Pick<OpenClawStateKyselyDatabase, "schema_meta">;
const stateDbLog = createSubsystemLogger("state/db");

function executeCanonicalStateSchema(
  database: DatabaseSync,
  options: { includeVersionLazyAdditiveTables: boolean },
): void {
  database.exec(getOpenClawStateRuntimeSchema(options));
}

function ensureSchema(
  db: DatabaseSync,
  pathname: string,
  env: NodeJS.ProcessEnv,
  busyTimeoutMs = OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
  initializeNativeOnly = false,
): void {
  try {
    if (isOpenClawStateSchemaFastPathEligible(db, pathname)) {
      // Recheck ownership so a claim made during validation cannot retain a writable handle.
      assertOpenClawStateWriteAllowed({ database: db, databasePath: pathname, env });
      return;
    }
  } catch {
    // Preserve the existing transactional repair and its diagnostics for drift or corruption.
  }

  withStateSchemaFence({ databasePath: pathname }, () => {
    const now = Date.now();
    const kysely = getNodeSqliteKysely<OpenClawStateMetadataDatabase>(db);
    const preMigrationBackup: PreMigrationBackupResult =
      !initializeNativeOnly || isUninitializedNativeStartupDatabase(db)
        ? createPreMigrationStateBackup(
            db,
            pathname,
            readSqliteUserVersion(db),
            OPENCLAW_STATE_SCHEMA_VERSION,
            now,
          )
        : { status: "skipped", reason: "native bootstrap does not migrate mature state" };
    db.exec("PRAGMA foreign_keys = OFF;"); // Rebuilding referenced tables requires this before BEGIN.
    try {
      const retirementMessages = runSqliteImmediateTransactionSync(
        db,
        () => {
          // Recheck ownership after BEGIN IMMEDIATE to exclude a concurrent external claim.
          assertOpenClawStateWriteAllowed({ database: db, databasePath: pathname, env });
          assertSupportedSchemaVersion(db, pathname);
          // Native bootstrap admission is advisory until this transaction owns the
          // write. Never migrate state initialized or occupied by a concurrent owner.
          if (initializeNativeOnly && !isUninitializedNativeStartupDatabase(db)) {
            return [];
          }
          const previousVersion = readSqliteUserVersion(db);
          assertPreMigrationSourceVersion(db, pathname, preMigrationBackup);
          if (previousVersion === OPENCLAW_STATE_SCHEMA_VERSION) {
            verifyAndRepairCanonicalSqliteIndexes(db, pathname, OPENCLAW_STATE_SCHEMA_SQL, {
              allowMissingColumns: true,
              validateAfterRepair: () => assertCurrentStateRuntimeSchema(db, pathname),
            });
            ensureAdditiveStateColumns(db);
            assertCurrentStateRuntimeSchema(db, pathname);
          } else {
            openClawStateMigrationAssertions.get(previousVersion)?.(db, { pathname });
          }
          dropLegacyStateTables(db);
          const migrationRetirementMessages = retirements.runRetiredStateTableMigrations(
            db,
            previousVersion,
          );
          migrateSingletonStateFoldInV12(db, previousVersion);
          migrateWorkerPlacementExecutionModeSchema(db, previousVersion);
          const pathMigration: AgentPathSummary = migrateAgentPaths(db, previousVersion, pathname);
          ensureAdditiveStateColumns(db);
          migrateJsonCanonicalWideRowsV13(db, previousVersion);
          migrateCronCreatorNamespaces(db, previousVersion);
          migrateConversationBindingTargets(db, previousVersion);
          sessionWatchMigration.migrateSessionWatchCursorProvenance(db);
          assertCanonicalStateSchemaShape(db, pathname);
          executeCanonicalStateSchema(db, {
            includeVersionLazyAdditiveTables: previousVersion !== OPENCLAW_STATE_SCHEMA_VERSION,
          });
          migrateLegacyCronRunLogsToTaskRuns(db);
          if (previousVersion < OPENCLAW_STATE_STRICT_SCHEMA_VERSION) {
            repairLegacyGatewayRestartHandoffsForStrictMigration(db);
            ensureFirstUseAdditiveStateColumnsForStrictMigration(db);
            migrateSqliteSchemaToStrictInTransaction(
              db,
              getOpenClawStateRuntimeSchema({
                includeVersionLazyAdditiveTables: previousVersion !== OPENCLAW_STATE_SCHEMA_VERSION,
              }),
              { databaseLabel: pathname },
            );
          }
          repairCanonicalSqliteIndexes(db, pathname, OPENCLAW_STATE_SCHEMA_SQL, {
            verifyPhysicalIntegrity: false,
          });
          db.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION};`);
          executeSqliteQuerySync(
            db,
            kysely
              .insertInto("schema_meta")
              .values({
                meta_key: "primary",
                role: "global",
                schema_version: OPENCLAW_STATE_SCHEMA_VERSION,
                agent_id: null,
                app_version: VERSION,
                created_at: now,
                updated_at: now,
              })
              .onConflict((conflict) =>
                conflict
                  .column("meta_key")
                  .doUpdateSet({
                    role: "global",
                    schema_version: OPENCLAW_STATE_SCHEMA_VERSION,
                    agent_id: null,
                    app_version: VERSION,
                    updated_at: now,
                  })
                  // updated_at tracks schema metadata changes; unconditional bumps dirty every
                  // open and defeat no-change backup detection.
                  .where((eb) =>
                    eb.or([
                      eb("schema_meta.schema_version", "!=", OPENCLAW_STATE_SCHEMA_VERSION),
                      eb("schema_meta.app_version", "is not", VERSION),
                      eb("schema_meta.role", "!=", "global"),
                    ]),
                  ),
              ),
          );
          assertOpenClawStateDatabaseForMaintenance(db, { pathname });
          warnAgentPathMigration(stateDbLog, pathMigration, pathname);
          return migrationRetirementMessages;
        },
        {
          busyTimeoutMs,
          databaseLabel: pathname,
          operationLabel: "state.schema.ensure",
        },
      );
      retirementMessages.forEach(retirements.logRetiredStateTableMigration);
      if (preMigrationBackup.status === "created") {
        const prunedPaths = prunePreMigrationStateBackups(pathname);
        if (prunedPaths.length > 0) {
          stateDbLog.info(
            `Pruned ${prunedPaths.length} older pre-migration backup(s), keeping the newest ${PRE_MIGRATION_BACKUP_RETENTION}`,
          );
        }
      }
    } finally {
      db.exec("PRAGMA foreign_keys = ON;");
    }
  });
}

/** Bootstrap fresh/native-only state canonically before startup checkpoint access. */
export function withOpenClawStateStartupMigrationCheckpointDatabase<T>(
  callback: (db: DatabaseSync) => T,
  options: OpenClawStateDatabaseOptions = {},
): T {
  return withOpenClawStateStartupCheckpointConnection(callback, options, ensureSchema);
}

/** Complete native bootstrap without migrating mature shared state. */
export function initializeNativeOpenClawStateDatabase(
  options: OpenClawStateDatabaseOptions = {},
): void {
  initializeNativeOpenClawStateConnection(options, (db, pathname, env) =>
    ensureSchema(db, pathname, env, OPENCLAW_SQLITE_BUSY_TIMEOUT_MS, true),
  );
}

/** Open existing shared state without creating, migrating, chmodding, or configuring it. */
export async function openExistingOpenClawStateDatabaseReadOnly(
  options: OpenClawStateDatabaseOptions = {},
): Promise<OpenClawStateDatabase | undefined> {
  const pathname = resolveDatabasePath(options);
  if (!existsSync(pathname)) {
    return undefined;
  }
  assertOpenClawStateDatabaseFreshOpenAllowed(options);
  const prepared = await prepareSqliteReadOnlyLocation(pathname);
  let db: DatabaseSync;
  try {
    db = openNodeSqliteDatabase(prepared.location, {
      readOnly: true,
    });
  } catch (error) {
    prepared.cleanup();
    throw error;
  }
  try {
    db.exec(`PRAGMA busy_timeout = ${OPENCLAW_SQLITE_BUSY_TIMEOUT_MS};`);
    assertSupportedSchemaVersion(db, pathname);
    assertSqliteIntegrity(db, pathname);
    if (readSqliteUserVersion(db) === OPENCLAW_STATE_SCHEMA_VERSION) {
      assertOpenClawStateDatabaseForMaintenance(db, { pathname });
    }
  } catch (error) {
    try {
      clearNodeSqliteKyselyCacheForDatabase(db);
      db.close();
    } catch {
      // Preserve the verification failure that explains why the database was refused.
    }
    prepared.cleanup();
    throw error;
  }
  let cleanupComplete = false;
  return {
    db,
    path: pathname,
    walMaintenance: {
      checkpoint: () => false,
      // Cleanup can fail transiently after the database closes. Keep the
      // close contract retryable until one call finishes both responsibilities.
      close: () => {
        const wasOpen = db.isOpen;
        if (!wasOpen && cleanupComplete) {
          return false;
        }
        try {
          if (wasOpen) {
            clearNodeSqliteKyselyCacheForDatabase(db);
            db.close();
          }
        } finally {
          cleanupComplete = prepared.cleanup();
        }
        return cleanupComplete;
      },
    },
  };
}

/** Open or return a cached shared state database after schema and migration checks. */

function openOpenClawStateDatabaseWithBusyTimeout(
  options: OpenClawStateDatabaseOptions = {},
  busyTimeoutMs = OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
  lockFailureReporting: SqliteLockFailureReporting = "report",
): OpenClawStateDatabase {
  const env = options.env ?? process.env;
  if (options.database) {
    assertOpenClawStateWriteAllowed({
      database: options.database.db,
      databasePath: options.database.path,
      env,
    });
    return options.database;
  }
  const pathname = resolveDatabasePath(options);
  // Latched paths are quarantined: the recorder closed any live handle, and
  // every open fails fast here until doctor repairs the file and clears it.
  try {
    stateDbCache.assertOpenClawStateDatabaseOpenAllowed(pathname);
  } catch (error) {
    stateDbCache.recordOpenClawStateDatabaseLifecycleOpenError(pathname, error);
    throw error;
  }
  const cached = stateDbCache.getCachedOpenClawStateDatabase(pathname);
  if (cached?.db.isOpen) {
    assertOpenClawStateWriteAllowed({
      database: cached.db,
      databasePath: pathname,
      env,
      schemaReady: true,
    });
    return cached;
  }
  try {
    assertOpenClawStateDatabaseFreshOpenAllowed(options);
  } catch (error) {
    stateDbCache.recordOpenClawStateDatabaseLifecycleOpenError(pathname, error);
    throw error;
  }
  let unpublished: OpenClawStateDatabase | undefined;
  try {
    unpublished = runWithOpenClawStateWriteAccess(
      { databasePath: pathname, busyTimeoutMs, env },
      "fresh state database open",
      () => {
        if (cached) {
          // A closed handle can leave Kysely and WAL helpers cached; clear both under access.
          stateDbCache.closeStaleCachedOpenClawStateDatabase(cached);
        }
        return (unpublished = openUnpublishedStateDatabase({
          pathname,
          env,
          busyTimeoutMs,
          lockFailureReporting,
          ensureSchema: (database) => ensureSchema(database, pathname, env, busyTimeoutMs),
          recordOpenFailure: recordOpenClawStateDatabaseOpenFailure,
        }));
      },
    );
  } catch (error) {
    if (lockFailureReporting === "report" || !isOpenClawStateWriteContentionError(error)) {
      stateDbCache.recordOpenClawStateDatabaseLifecycleOpenError(pathname, error);
    }
    if (!unpublished) {
      throw error;
    }
    const cleanup = stateDbCache.closeOpenClawStateDatabaseHandle(unpublished);
    if (cleanup.caught) {
      throw createSqliteLifecycleAggregateError(
        [error, ...cleanup.errors],
        `Fresh OpenClaw state database open failed releasing access and closing its unpublished handle for ${pathname}.`,
        error,
      );
    }
    throw error;
  }
  return stateDbCache.publishOpenClawStateDatabase(unpublished);
}

/** Open or return a cached shared state database after schema and migration checks. */
export function openOpenClawStateDatabase(
  options: OpenClawStateDatabaseOptions = {},
): OpenClawStateDatabase {
  return openOpenClawStateDatabaseWithBusyTimeout(options);
}

/** Run one operation through the shared owner without waiting synchronously on SQLite locks. */
export function runWithOpenClawStateBusyTimeout<T>(
  operation: (database: OpenClawStateDatabase) => T,
  options: OpenClawStateDatabaseOptions,
  busyTimeoutMs: number,
): T {
  const normalizedTimeoutMs = normalizeSqliteNonNegativeInteger(busyTimeoutMs, "busyTimeoutMs");
  const existing = options.database ?? getOpenClawStateDatabaseIfOpen(options);
  if (existing) {
    return runWithSqliteBusyTimeout(existing.db, normalizedTimeoutMs, () => operation(existing), {
      lockFailureReporting: "suppress",
    });
  }
  const opened = openOpenClawStateDatabaseWithBusyTimeout(options, normalizedTimeoutMs, "suppress");
  try {
    return runWithSqliteBusyTimeout(opened.db, normalizedTimeoutMs, () => operation(opened), {
      lockFailureReporting: "suppress",
    });
  } finally {
    if (opened.db.isOpen) {
      setSqliteBusyTimeout(opened.db, OPENCLAW_SQLITE_BUSY_TIMEOUT_MS);
    }
  }
}

/** Run a synchronous immediate transaction against the shared state database. */
export function runOpenClawStateWriteTransaction<T>(
  operation: (database: OpenClawStateDatabase) => T,
  options: OpenClawStateDatabaseOptions = {},
  transactionOptions: Pick<
    SqliteTransactionOptions,
    "busyTimeoutMs" | "operationLabel" | "slowTransactionHoldMs"
  > = {},
): T {
  let database = options.database ?? getOpenClawStateDatabaseIfOpen(options);
  let result: T;
  try {
    const acquired = options.database
      ? openOpenClawStateDatabase(options)
      : (database ?? openOpenClawStateDatabase(options));
    database = acquired;
    result = withSqlitePostCommitPublications(acquired.db, () =>
      runSqliteImmediateTransactionSync(
        acquired.db,
        () => {
          assertOpenClawStateWriteAllowed({
            database: acquired.db,
            databasePath: acquired.path,
            env: options.env ?? process.env,
            schemaReady: !options.database && acquired === getOpenClawStateDatabaseIfOpen(options),
          });
          return operation(acquired);
        },
        {
          busyTimeoutMs: transactionOptions.busyTimeoutMs ?? readSqliteBusyTimeout(acquired.db),
          databaseLabel: acquired.path,
          ...transactionOptions,
          operationLabel: transactionOptions.operationLabel ?? "state.write",
        },
      ),
    );
  } catch (error) {
    if (database) {
      stateDbCache.evictOpenClawStateDatabaseAfterCorruption(database, error);
    }
    throw error;
  }
  try {
    ensureOpenClawStatePermissions(database.path, options.env ?? process.env);
  } catch {
    // The write already committed; permission hardening is best-effort here so
    // callers never retry an operation that is durable in SQLite.
  }
  return result;
}

/**
 * Return a shared state handle this process already holds open, if any.
 *
 * Read-only callers use this to avoid opening a connection per call; it never
 * creates, repairs, or registers a handle.
 */
function getOpenClawStateDatabaseIfOpen(
  options: OpenClawStateDatabaseOptions = {},
): OpenClawStateDatabase | undefined {
  return stateDbCache.getOpenClawStateDatabaseIfOpenAtPath(resolveDatabasePath(options));
}

export {
  recordOpenClawStateDatabaseOpenFailure,
  clearOpenClawStateDatabaseOpenFailure,
  closeOpenClawStateDatabaseByPath,
  closeOpenClawStateDatabase,
  isOpenClawStateDatabaseOpen,
  closeOpenClawStateDatabaseForTest,
} from "./openclaw-state-db-cache.js";

import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { clearNodeSqliteKyselyCacheForDatabase } from "../infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { repairCanonicalSqliteIndexes } from "../infra/sqlite-index-schema.js";
import { assertSqliteIntegrity } from "../infra/sqlite-integrity.js";
import { assertSqliteSchemaTablesPresent } from "../infra/sqlite-schema-contract.js";
import { migrateSqliteSchemaToStrictInTransaction } from "../infra/sqlite-strict.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { readSqliteUserVersion } from "../infra/sqlite-user-version.js";
import { withStateSchemaFence } from "../infra/state-database-coordinator.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { clearOpenClawDatabaseQuarantine } from "./openclaw-quarantine-store.js";
import { repairAuditEventsSchema } from "./openclaw-state-db-audit-migration.js";
import { clearOpenClawStateDatabaseOpenFailure } from "./openclaw-state-db-cache.js";
import {
  LAZY_ADDITIVE_STATE_TABLES,
  OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
  OPENCLAW_STATE_SCHEMA_VERSION,
  OPENCLAW_STATE_STRICT_SCHEMA_VERSION,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db-contract.js";
import { assertCurrentStateRuntimeSchema } from "./openclaw-state-db-fast-path.js";
import {
  assertSupportedSchemaVersion,
  markCurrentStateSchemaVersion,
  migrateConversationBindingTargets,
  migrateCronCreatorNamespaces,
  openClawStateMigrationAssertions,
  resolveDatabasePath,
} from "./openclaw-state-db-maintenance.js";
import * as operatorApprovalMigration from "./openclaw-state-db-operator-approval-migration.js";
import { ensureOpenClawStatePermissions } from "./openclaw-state-db-permissions.js";
import {
  ensureAdditiveStateColumns,
  ensureFirstUseAdditiveStateColumnsForStrictMigration,
} from "./openclaw-state-db-schema-additive.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import {
  assertCanonicalStateSchemaShape,
  detectOpenClawStateDatabaseSchemaMigrationsFromDatabase,
  dropLegacyStateTables,
  migrateAgentDatabaseRelativePaths as migrateAgentPaths,
  migrateWorkerPlacementExecutionModeSchema,
  repairAgentDatabasesCompositePrimaryKey,
  repairLegacyGatewayRestartHandoffsForStrictMigration,
} from "./openclaw-state-db-schema-repair.js";
import { migrateSingletonStateFoldInV12 } from "./openclaw-state-db-schema-v12-foldin.js";
import { migrateJsonCanonicalWideRowsV13 } from "./openclaw-state-db-schema-v13-widerow.js";
import * as sessionWatchMigration from "./openclaw-state-db-session-watch-migration.js";
import * as retirements from "./openclaw-state-db-table-retirements.js";
import { describeAgentPathMigration } from "./openclaw-state-db.paths.js";
import {
  assertOpenClawStateWriteAllowed,
  OpenClawStateOwnershipError,
  runWithOpenClawStateWriteAccess,
} from "./openclaw-state-ownership.js";
import {
  assertPreMigrationSourceVersion,
  createPreMigrationStateBackup,
  PRE_MIGRATION_BACKUP_RETENTION,
  PreMigrationBackupError,
  type PreMigrationBackupResult,
  prunePreMigrationStateBackups,
} from "./openclaw-state-pre-migration-backup.js";
import { getOpenClawStateRuntimeSchema } from "./openclaw-state-schema-compatibility.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

type StateSchemaRepairResult = {
  changes: string[];
  warnings: string[];
};

const stateDbLog = createSubsystemLogger("state/db");

function executeCanonicalStateSchema(
  database: DatabaseSync,
  options: { includeVersionLazyAdditiveTables: boolean },
): void {
  database.exec(getOpenClawStateRuntimeSchema(options)); // sqlite-allow-raw -- Canonical schema DDL inside Doctor repair.
}

function repairStateSchema(pathname: string, env: NodeJS.ProcessEnv): StateSchemaRepairResult {
  ensureOpenClawStatePermissions(pathname, env);
  const db = openNodeSqliteDatabase(pathname);
  const rebuiltIndexNames = new Set<string>();
  let ownershipRefused = false;
  try {
    db.exec(`PRAGMA busy_timeout = ${OPENCLAW_SQLITE_BUSY_TIMEOUT_MS};`); // sqlite-allow-raw -- Connection-local repair lock policy.
    assertSupportedSchemaVersion(db, pathname);
    // Pre-v2 repair deliberately leaves a missing audit ledger for normal open,
    // which takes its own snapshot immediately before advancing the version.
    const preMigrationBackup: PreMigrationBackupResult = tableExists(db, "audit_events")
      ? createPreMigrationStateBackup(
          db,
          pathname,
          readSqliteUserVersion(db),
          OPENCLAW_STATE_SCHEMA_VERSION,
          Date.now(),
        )
      : { status: "skipped", reason: "repair leaves a missing pre-v2 audit ledger untouched" };
    db.exec("PRAGMA foreign_keys = OFF;"); // sqlite-allow-raw -- Legacy table rebuilds require connection-local FK suspension before BEGIN.
    const changes = runSqliteImmediateTransactionSync(
      db,
      () => {
        assertOpenClawStateWriteAllowed({ database: db, databasePath: pathname, env });
        const applied: string[] = [];
        const previousVersion = readSqliteUserVersion(db);
        assertPreMigrationSourceVersion(db, pathname, preMigrationBackup);
        if (previousVersion === OPENCLAW_STATE_SCHEMA_VERSION) {
          for (const name of repairCanonicalSqliteIndexes(db, pathname, OPENCLAW_STATE_SCHEMA_SQL, {
            allowMissingColumns: true,
          })) {
            rebuiltIndexNames.add(name);
          }
          // Current-schema doctor repair may normalize recognized columns or
          // table options, but it must never recreate a missing table empty.
          assertSqliteSchemaTablesPresent(db, pathname, OPENCLAW_STATE_SCHEMA_SQL, {
            allowedMissingTables: LAZY_ADDITIVE_STATE_TABLES,
          });
        } else {
          openClawStateMigrationAssertions.get(previousVersion)?.(db, { pathname });
        }
        if (rebuiltIndexNames.size === 0) {
          assertSqliteIntegrity(db, pathname);
        }
        dropLegacyStateTables(db);
        applied.push(...retirements.runRetiredStateTableMigrations(db, previousVersion));
        if (migrateSingletonStateFoldInV12(db, previousVersion)) {
          applied.push("Folded singleton state tables into config_machine_state (v12)");
        }
        if (migrateWorkerPlacementExecutionModeSchema(db, previousVersion)) {
          applied.push("Migrated cloud worker placements to execution modes");
        }
        applied.push(
          ...describeAgentPathMigration(migrateAgentPaths(db, previousVersion, pathname)),
        );
        if (repairAgentDatabasesCompositePrimaryKey(db)) {
          applied.push(`Migrated shared state agent database registry primary key → agent_id,path`);
        }
        if (repairAuditEventsSchema(db)) {
          applied.push(
            `Migrated shared state audit event ledger → versioned message lifecycle schema`,
          );
        }
        applied.push(...operatorApprovalMigration.repairOperatorApprovalSchema(db));
        const needsSessionWatchMigration =
          sessionWatchMigration.needsSessionWatchCursorProvenanceMigration(db, previousVersion);
        const sessionWatchResult = sessionWatchMigration.migrateSessionWatchCursorProvenance(db);
        if (needsSessionWatchMigration) {
          applied.push(
            `Migrated shared state session watch cursors → provenance column (${sessionWatchResult.migratedAmbientWatches} ambient, ${sessionWatchResult.removedLegacySentinels} sentinels removed)`,
          );
        }
        assertCanonicalStateSchemaShape(db, pathname);
        if (tableExists(db, "audit_events")) {
          ensureAdditiveStateColumns(db);
          if (migrateJsonCanonicalWideRowsV13(db, previousVersion)) {
            applied.push("Consolidated shared state tables (v13)");
          }
          if (migrateCronCreatorNamespaces(db, previousVersion)) {
            applied.push("Qualified historical cron creator attribution as unknown (v14)");
          }
          if (migrateConversationBindingTargets(db, previousVersion)) {
            applied.push("Removed redundant conversation binding target projections (v15)");
          }
          executeCanonicalStateSchema(db, {
            includeVersionLazyAdditiveTables: previousVersion !== OPENCLAW_STATE_SCHEMA_VERSION,
          });
          if (previousVersion < OPENCLAW_STATE_STRICT_SCHEMA_VERSION) {
            repairLegacyGatewayRestartHandoffsForStrictMigration(db);
            ensureFirstUseAdditiveStateColumnsForStrictMigration(db);
          }
          const strictMigration = migrateSqliteSchemaToStrictInTransaction(
            db,
            getOpenClawStateRuntimeSchema({
              includeVersionLazyAdditiveTables: previousVersion !== OPENCLAW_STATE_SCHEMA_VERSION,
            }),
            { databaseLabel: pathname },
          );
          if (strictMigration.migratedTables.length > 0) {
            applied.push(
              `Migrated shared state tables to SQLite STRICT typing (${strictMigration.migratedTables.length})`,
            );
          }
          for (const name of repairCanonicalSqliteIndexes(db, pathname, OPENCLAW_STATE_SCHEMA_SQL, {
            verifyPhysicalIntegrity: false,
          })) {
            rebuiltIndexNames.add(name);
          }
        }
        markCurrentStateSchemaVersion(db, {
          createMetadataIfMissing: previousVersion < OPENCLAW_STATE_SCHEMA_VERSION,
        });
        if (readSqliteUserVersion(db) === OPENCLAW_STATE_SCHEMA_VERSION) {
          assertCurrentStateRuntimeSchema(db, pathname);
        }
        if (rebuiltIndexNames.size > 0) {
          applied.push(`Rebuilt canonical shared-state SQLite indexes (${rebuiltIndexNames.size})`);
        }
        return applied;
      },
      {
        busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
        databaseLabel: pathname,
        operationLabel: "state.schema.repair",
      },
    );
    const quarantineCleared = clearOpenClawDatabaseQuarantine(pathname, { env });
    clearOpenClawStateDatabaseOpenFailure(pathname);
    const prunedPaths =
      preMigrationBackup.status === "created" ? prunePreMigrationStateBackups(pathname) : [];
    if (prunedPaths.length > 0) {
      stateDbLog.info(
        `Pruned ${prunedPaths.length} older pre-migration backup(s), keeping the newest ${PRE_MIGRATION_BACKUP_RETENTION}`,
      );
    }
    return {
      changes,
      warnings: quarantineCleared
        ? []
        : [
            `Persisted quarantine record for ${pathname} could not be cleared; rerun openclaw doctor --fix so the repaired database is not refused again.`,
          ],
    };
  } catch (err) {
    if (err instanceof PreMigrationBackupError) {
      throw err;
    }
    if (err instanceof OpenClawStateOwnershipError) {
      ownershipRefused = true;
      throw err;
    }
    // Reaching this catch inside doctor means repair itself refused or failed,
    // so the runtime asserts' "run openclaw doctor --fix" advice is circular here.
    const reason = String(err).replace(
      /has a legacy ([a-z ]+) schema; run openclaw doctor --fix to migrate it\./u,
      "has a legacy $1 schema; automatic repair refused the unrecognized schema shape.",
    );
    return {
      changes: [],
      warnings: [`Failed migrating shared state database schema at ${pathname}: ${reason}`],
    };
  } finally {
    if (db.isOpen) {
      db.exec("PRAGMA foreign_keys = ON;"); // sqlite-allow-raw -- Restore the connection-local FK policy before close.
    }
    clearNodeSqliteKyselyCacheForDatabase(db);
    db.close();
    if (!ownershipRefused) {
      ensureOpenClawStatePermissions(pathname, env);
    }
  }
}

export function repairOpenClawStateDatabaseSchema(
  options: OpenClawStateDatabaseOptions = {},
): StateSchemaRepairResult {
  const env = options.env ?? process.env;
  const pathname = resolveDatabasePath(options);
  if (!existsSync(pathname)) {
    return { changes: [], warnings: [] };
  }
  return runWithOpenClawStateWriteAccess(
    { databasePath: pathname, env },
    "state schema repair",
    () => withStateSchemaFence({ databasePath: pathname }, () => repairStateSchema(pathname, env)),
  );
}

function needsOpenClawStateDatabaseSchemaRepair(pathname: string): boolean {
  let database: DatabaseSync | undefined;
  try {
    database = openNodeSqliteDatabase(pathname, { readOnly: true });
    assertSupportedSchemaVersion(database, pathname);
    const needsRepair =
      readSqliteUserVersion(database) !== OPENCLAW_STATE_SCHEMA_VERSION ||
      detectOpenClawStateDatabaseSchemaMigrationsFromDatabase(database, pathname).length > 0;
    if (!needsRepair) {
      assertCurrentStateRuntimeSchema(database, pathname);
    }
    return needsRepair;
  } catch {
    // Preserve the repair path's existing diagnostics for unreadable or noncanonical databases.
    return true;
  } finally {
    database?.close();
  }
}

/** Skip the exclusive doctor repair when automatic migration sees a canonical current schema. */
export function repairOpenClawStateDatabaseSchemaIfNeeded(
  options: OpenClawStateDatabaseOptions = {},
): StateSchemaRepairResult {
  const env = options.env ?? process.env;
  const pathname = resolveDatabasePath(options);
  if (!existsSync(pathname)) {
    return { changes: [], warnings: [] };
  }

  return runWithOpenClawStateWriteAccess(
    { databasePath: pathname, env },
    "state schema repair preflight/repair",
    () =>
      needsOpenClawStateDatabaseSchemaRepair(pathname)
        ? withStateSchemaFence({ databasePath: pathname }, () => repairStateSchema(pathname, env))
        : { changes: [], warnings: [] },
  );
}

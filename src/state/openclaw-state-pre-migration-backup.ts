import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { applyPrivateModeSync } from "../infra/private-mode.js";
import { assertSqliteIntegrity } from "../infra/sqlite-integrity.js";
import { readSqliteUserVersion } from "../infra/sqlite-user-version.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const BACKUP_DIR_MODE = 0o700;
const BACKUP_FILE_MODE = 0o600;
const BACKUP_FILE_SUFFIX = ".sqlite";
const BACKUP_FILE_PATTERN =
  /^openclaw-(?<kind>state|agent)-(?<source>[0-9a-f]{12})-v(?<from>\d+)-to-v(?<to>\d+)-(?<stamp>\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.sqlite$/u;
const SQLITE_HEADER = Buffer.from("53514c69746520666f726d6174203300", "hex");

const PRE_MIGRATION_BACKUP_DIRNAME = "pre-migration-backups";
export const PRE_MIGRATION_BACKUP_RETENTION = 3;
const preMigrationBackupLog = createSubsystemLogger("state/pre-migration-backup");

export type PreMigrationBackupResult =
  | {
      status: "created";
      backupPath: string;
      fromVersion: number;
      kind: "state" | "agent";
      label: string;
      toVersion: number;
    }
  | { status: "skipped"; reason: string };

export class PreMigrationBackupError extends Error {
  constructor(
    readonly databasePath: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PreMigrationBackupError";
  }
}

export function assertPreMigrationSourceVersion(
  db: DatabaseSync,
  pathname: string,
  backup: PreMigrationBackupResult | undefined,
): void {
  if (backup?.status === "created" && readSqliteUserVersion(db) !== backup.fromVersion) {
    throw new Error(`${backup.label} schema changed after its backup was created: ${pathname}`);
  }
}

function requirePrivateMode(target: string, mode: number): void {
  const result = applyPrivateModeSync(target, mode);
  if (!result.applied && (fs.statSync(target).mode & 0o077) !== 0) {
    throw new Error(`Filesystem cannot enforce private permissions on ${target}`, {
      cause: result.error,
    });
  }
}

function prepareBackupDirectory(pathname: string): string {
  const backupDir = path.join(path.dirname(pathname), PRE_MIGRATION_BACKUP_DIRNAME);
  fs.mkdirSync(backupDir, { recursive: true, mode: BACKUP_DIR_MODE });
  const entry = fs.lstatSync(backupDir);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error(`Pre-migration backup path must be a real directory: ${backupDir}`);
  }
  requirePrivateMode(backupDir, BACKUP_DIR_MODE);
  return backupDir;
}

function backupSourceKey(pathname: string): string {
  return createHash("sha256").update(path.basename(pathname)).digest("hex").slice(0, 12);
}

/**
 * Classify only exact module-owned files. Full integrity is required for the
 * newly created recovery point; retention scans avoid rereading every older
 * database in full on each migration.
 */
function readManagedSnapshotVersion(
  filePath: string,
  name: string,
  kind: "state" | "agent",
  sourceKey: string,
  options: { verifyIntegrity?: boolean } = {},
): number | undefined {
  const match = BACKUP_FILE_PATTERN.exec(name);
  if (!match?.groups?.from || match.groups.kind !== kind || match.groups.source !== sourceKey) {
    return undefined;
  }
  try {
    const entry = fs.lstatSync(filePath);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(filePath, "r");
    const header = Buffer.alloc(SQLITE_HEADER.length);
    if (fs.readSync(descriptor, header, 0, header.length, 0) !== header.length) {
      return undefined;
    }
    if (!header.equals(SQLITE_HEADER)) {
      return undefined;
    }
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Classification is read-only; closing cannot invalidate verified bytes.
      }
    }
  }

  let database: DatabaseSync | undefined;
  try {
    database = openNodeSqliteDatabase(filePath, { readOnly: true });
    if (options.verifyIntegrity === true) {
      assertSqliteIntegrity(database, filePath);
    }
    const version = readSqliteUserVersion(database);
    return version === Number(match.groups.from) ? version : undefined;
  } catch {
    return undefined;
  } finally {
    try {
      database?.close();
    } catch {
      // Classification is read-only; closing cannot invalidate verified bytes.
    }
  }
}

function managedSnapshots(
  backupDir: string,
  kind: "state" | "agent",
  sourceKey: string,
): Array<{
  filePath: string;
  fromVersion: number;
  stamp: string;
  toVersion: number;
}> {
  return fs
    .readdirSync(backupDir)
    .flatMap((name) => {
      const match = BACKUP_FILE_PATTERN.exec(name);
      const filePath = path.join(backupDir, name);
      const fromVersion = readManagedSnapshotVersion(filePath, name, kind, sourceKey);
      const stamp = match?.groups?.stamp;
      const toVersion = Number(match?.groups?.to);
      return fromVersion !== undefined && stamp && Number.isSafeInteger(toVersion)
        ? [{ filePath, fromVersion, stamp, toVersion }]
        : [];
    })
    .toSorted(
      (left, right) =>
        right.stamp.localeCompare(left.stamp) || right.filePath.localeCompare(left.filePath),
    );
}

function removeSnapshotsBestEffort(paths: readonly string[]): string[] {
  const removed: string[] = [];
  for (const filePath of paths) {
    try {
      fs.rmSync(filePath);
      removed.push(filePath);
    } catch {
      // A retained recovery copy is safe; the next successful migration retries pruning.
    }
  }
  return removed;
}

/** Remove older managed copies only after the schema migration commits. */
function prunePreMigrationBackups(pathname: string, kind: "state" | "agent"): string[] {
  const backupDir = path.join(path.dirname(pathname), PRE_MIGRATION_BACKUP_DIRNAME);
  try {
    const entry = fs.lstatSync(backupDir);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      return [];
    }
    return removeSnapshotsBestEffort(
      managedSnapshots(backupDir, kind, backupSourceKey(pathname))
        .slice(PRE_MIGRATION_BACKUP_RETENTION)
        .map((snapshot) => snapshot.filePath),
    );
  } catch {
    return [];
  }
}

export function prunePreMigrationStateBackups(pathname: string): string[] {
  return prunePreMigrationBackups(pathname, "state");
}

export function prunePreMigrationAgentBackups(pathname: string): string[] {
  return prunePreMigrationBackups(pathname, "agent");
}

function createPreMigrationBackup(
  db: DatabaseSync,
  pathname: string,
  fromVersion: number,
  toVersion: number,
  now: number,
  kind: "state" | "agent",
  label: string,
  options: {
    sourceIntegrity: "direct" | "rollback-probed";
    repairSnapshot?: (database: DatabaseSync) => void;
  },
): PreMigrationBackupResult {
  if (fromVersion < 0 || fromVersion >= toVersion) {
    return { status: "skipped", reason: "no forward schema migration pending" };
  }
  if (
    fromVersion === 0 &&
    db // sqlite-allow-raw -- Pre-migration schema presence probe before Kysely exposure.
      .prepare("SELECT 1 AS present FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 1")
      .get() === undefined
  ) {
    return { status: "skipped", reason: "new database has no persisted schema to protect" };
  }
  if (db.isTransaction) {
    throw new PreMigrationBackupError(
      pathname,
      `Cannot back up ${pathname} after its schema transaction has started.`,
    );
  }

  let backupPath: string | undefined;
  try {
    // Released agent v17 databases can contain repairable canonical-index drift.
    // Their caller proves the repair in a rolled-back transaction; VACUUM rebuilds
    // the snapshot indexes, and the resulting copy still passes full verification below.
    if (options.sourceIntegrity === "direct") {
      assertSqliteIntegrity(db, pathname);
    }
    const backupDir = prepareBackupDirectory(pathname);
    const sourceKey = backupSourceKey(pathname);
    const supersededSnapshots = managedSnapshots(backupDir, kind, sourceKey).filter(
      (snapshot) => snapshot.fromVersion === fromVersion && snapshot.toVersion === toVersion,
    );
    const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
    backupPath = path.join(
      backupDir,
      `openclaw-${kind}-${sourceKey}-v${fromVersion}-to-v${toVersion}-${stamp}-${randomUUID()}${BACKUP_FILE_SUFFIX}`,
    );
    db.prepare("VACUUM INTO ?").run(backupPath); // sqlite-allow-raw -- VACUUM INTO has no Kysely form and must run before the migration transaction.
    requirePrivateMode(backupPath, BACKUP_FILE_MODE);
    if (options.repairSnapshot) {
      const snapshotDatabase = openNodeSqliteDatabase(backupPath);
      try {
        options.repairSnapshot(snapshotDatabase);
      } finally {
        snapshotDatabase.close();
      }
    }
    if (
      readManagedSnapshotVersion(backupPath, path.basename(backupPath), kind, sourceKey, {
        verifyIntegrity: true,
      }) !== fromVersion
    ) {
      throw new Error(`Pre-migration backup failed verification: ${backupPath}`);
    }
    if (readSqliteUserVersion(db) !== fromVersion) {
      throw new Error(
        `Database schema changed while its pre-migration backup was created: ${pathname}`,
      );
    }
    // A retry must capture writes made by an older build after the previous
    // attempt. Once the fresh copy verifies, older copies for this exact
    // transition are redundant and can be removed without risking recovery.
    removeSnapshotsBestEffort(supersededSnapshots.map((snapshot) => snapshot.filePath));
    const result: Extract<PreMigrationBackupResult, { status: "created" }> = {
      status: "created",
      backupPath,
      fromVersion,
      kind,
      label,
      toVersion,
    };
    preMigrationBackupLog.info(
      `Backed up ${result.label} before schema migration → ${result.backupPath}`,
    );
    return result;
  } catch (error) {
    if (backupPath) {
      try {
        fs.rmSync(backupPath, { force: true });
      } catch {
        // Preserve the backup failure as the primary error; the unique path is reported below.
      }
    }
    throw new PreMigrationBackupError(
      pathname,
      `Refusing schema migration because a verified pre-migration backup could not be created for ${pathname}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/** Create a verified private copy before a shared-state schema migration. */
export function createPreMigrationStateBackup(
  db: DatabaseSync,
  pathname: string,
  fromVersion: number,
  toVersion: number,
  now: number,
): PreMigrationBackupResult {
  return createPreMigrationBackup(
    db,
    pathname,
    fromVersion,
    toVersion,
    now,
    "state",
    "shared state database",
    { sourceIntegrity: "direct" },
  );
}

/** Create a verified private copy before a per-agent schema migration. */
export function createPreMigrationAgentBackup(
  db: DatabaseSync,
  pathname: string,
  agentId: string,
  fromVersion: number,
  toVersion: number,
  now: number,
  options: {
    sourceIntegrity: "direct" | "rollback-probed";
    repairSnapshot?: (database: DatabaseSync) => void;
  } = {
    sourceIntegrity: "direct",
  },
): PreMigrationBackupResult {
  return createPreMigrationBackup(
    db,
    pathname,
    fromVersion,
    toVersion,
    now,
    "agent",
    `agent ${agentId} database`,
    options,
  );
}

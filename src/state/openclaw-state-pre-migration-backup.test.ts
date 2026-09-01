import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  createPreMigrationStateBackup,
  PRE_MIGRATION_BACKUP_RETENTION,
  PreMigrationBackupError,
  prunePreMigrationStateBackups,
} from "./openclaw-state-pre-migration-backup.js";

const PRE_MIGRATION_BACKUP_DIRNAME = "pre-migration-backups";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function seedStateDb(dbPath: string, userVersion: number): void {
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE IF NOT EXISTS demo (id INTEGER PRIMARY KEY, note TEXT);");
  db.exec("INSERT INTO demo (id, note) VALUES (1, 'keep-me');");
  db.exec(`PRAGMA user_version = ${userVersion};`);
  db.close();
}

describe("createPreMigrationStateBackup", () => {
  it("snapshots the database before a forward migration", () => {
    const dir = tempDirs.make("openclaw-pre-migration-backup-");
    const dbPath = path.join(dir, "openclaw.sqlite");
    seedStateDb(dbPath, 5);
    const db = new DatabaseSync(dbPath);
    try {
      const result = createPreMigrationStateBackup(
        db,
        dbPath,
        5,
        6,
        Date.parse("2026-07-25T09:40:00Z"),
      );
      expect(result.status).toBe("created");
      if (result.status !== "created") {
        return;
      }
      expect(fs.existsSync(result.backupPath)).toBe(true);
      expect(result.backupPath).toContain(PRE_MIGRATION_BACKUP_DIRNAME);
      expect(result.backupPath).toContain("v5-to-v6");
      if (process.platform !== "win32") {
        expect(fs.statSync(path.dirname(result.backupPath)).mode & 0o777).toBe(0o700);
        expect(fs.statSync(result.backupPath).mode & 0o777).toBe(0o600);
      }

      // The backup is a valid SQLite database carrying the pre-migration
      // version and the pre-migration data.
      const backup = new DatabaseSync(result.backupPath);
      try {
        const version = backup.prepare("PRAGMA user_version;").get() as {
          user_version: number;
        };
        expect(version.user_version).toBe(5);
        const row = backup.prepare("SELECT note FROM demo WHERE id = 1;").get() as {
          note: string;
        };
        expect(row.note).toBe("keep-me");
      } finally {
        backup.close();
      }
    } finally {
      db.close();
    }
  });

  it("skips when the database is already at the target version", () => {
    const dir = tempDirs.make("openclaw-pre-migration-backup-");
    const dbPath = path.join(dir, "openclaw.sqlite");
    seedStateDb(dbPath, 6);
    const db = new DatabaseSync(dbPath);
    try {
      const result = createPreMigrationStateBackup(db, dbPath, 6, 6, Date.now());
      expect(result.status).toBe("skipped");
      expect(fs.existsSync(path.join(dir, PRE_MIGRATION_BACKUP_DIRNAME))).toBe(false);
    } finally {
      db.close();
    }
  });

  it("skips a brand new (version 0) database", () => {
    const dir = tempDirs.make("openclaw-pre-migration-backup-");
    const dbPath = path.join(dir, "openclaw.sqlite");
    const db = new DatabaseSync(dbPath);
    try {
      const result = createPreMigrationStateBackup(db, dbPath, 0, 6, Date.now());
      expect(result.status).toBe("skipped");
      expect(fs.existsSync(path.join(dir, PRE_MIGRATION_BACKUP_DIRNAME))).toBe(false);
    } finally {
      db.close();
    }
  });

  it("protects a populated unversioned database", () => {
    const dir = tempDirs.make("openclaw-pre-migration-backup-");
    const dbPath = path.join(dir, "openclaw.sqlite");
    seedStateDb(dbPath, 0);
    const db = new DatabaseSync(dbPath);
    try {
      const result = createPreMigrationStateBackup(db, dbPath, 0, 6, Date.now());
      expect(result.status).toBe("created");
      if (result.status !== "created") {
        return;
      }
      const backup = new DatabaseSync(result.backupPath, { readOnly: true });
      try {
        expect(backup.prepare("SELECT note FROM demo WHERE id = 1").get()).toEqual({
          note: "keep-me",
        });
      } finally {
        backup.close();
      }
    } finally {
      db.close();
    }
  });

  it("replaces a prior attempt with a fresh snapshot of the current data", () => {
    const dir = tempDirs.make("openclaw-pre-migration-backup-");
    const dbPath = path.join(dir, "openclaw.sqlite");
    seedStateDb(dbPath, 5);
    const db = new DatabaseSync(dbPath);
    try {
      const first = createPreMigrationStateBackup(db, dbPath, 5, 6, 1_700_000_000_000);
      db.prepare("UPDATE demo SET note = 'newer-write' WHERE id = 1").run();
      const second = createPreMigrationStateBackup(db, dbPath, 5, 6, 1_700_000_000_000);
      expect(first.status).toBe("created");
      expect(second.status).toBe("created");
      if (first.status !== "created" || second.status !== "created") {
        return;
      }
      expect(second.backupPath).not.toBe(first.backupPath);
      expect(fs.existsSync(first.backupPath)).toBe(false);
      expect(fs.readdirSync(path.dirname(first.backupPath))).toHaveLength(1);
      const refreshed = new DatabaseSync(second.backupPath, { readOnly: true });
      try {
        expect(refreshed.prepare("SELECT note FROM demo WHERE id = 1").get()).toEqual({
          note: "newer-write",
        });
      } finally {
        refreshed.close();
      }
    } finally {
      db.close();
    }
  });

  it("never supersedes another database's snapshot in the same directory", () => {
    const dir = tempDirs.make("openclaw-pre-migration-backup-");
    const firstPath = path.join(dir, "first.sqlite");
    const secondPath = path.join(dir, "second.sqlite");
    seedStateDb(firstPath, 5);
    seedStateDb(secondPath, 5);
    const first = new DatabaseSync(firstPath);
    const second = new DatabaseSync(secondPath);
    try {
      const firstResult = createPreMigrationStateBackup(first, firstPath, 5, 6, Date.now());
      const secondResult = createPreMigrationStateBackup(second, secondPath, 5, 6, Date.now());
      expect(firstResult.status).toBe("created");
      expect(secondResult.status).toBe("created");
      if (firstResult.status !== "created" || secondResult.status !== "created") {
        return;
      }

      createPreMigrationStateBackup(first, firstPath, 5, 6, Date.now());

      expect(fs.existsSync(firstResult.backupPath)).toBe(false);
      expect(fs.existsSync(secondResult.backupPath)).toBe(true);
      expect(fs.readdirSync(path.dirname(firstResult.backupPath))).toHaveLength(2);
    } finally {
      first.close();
      second.close();
    }
  });

  it("prunes only exact managed snapshots after migration success", () => {
    const dir = tempDirs.make("openclaw-pre-migration-backup-");
    const dbPath = path.join(dir, "openclaw.sqlite");
    seedStateDb(dbPath, 1);
    const db = new DatabaseSync(dbPath);
    try {
      const createdPaths: string[] = [];
      for (const [index, fromVersion] of [8, 9, 10, 11].entries()) {
        db.exec(`PRAGMA user_version = ${fromVersion};`);
        const result = createPreMigrationStateBackup(
          db,
          dbPath,
          fromVersion,
          fromVersion + 1,
          Date.UTC(2026, 0, index + 1),
        );
        if (result.status === "created") {
          createdPaths.push(result.backupPath);
        }
      }
      const backupDir = path.join(dir, PRE_MIGRATION_BACKUP_DIRNAME);
      const lookalike = path.join(
        backupDir,
        "openclaw-state-000000000000-v1-to-v2-2025-12-31T00-00-00-000Z-00000000-0000-4000-8000-000000000000.sqlite",
      );
      fs.writeFileSync(lookalike, "operator file");

      const removed = prunePreMigrationStateBackups(dbPath);

      expect(removed).toEqual([createdPaths[0]]);
      expect(fs.existsSync(lookalike)).toBe(true);
      expect(
        fs.readdirSync(backupDir).filter((name) => name !== path.basename(lookalike)),
      ).toHaveLength(PRE_MIGRATION_BACKUP_RETENTION);
    } finally {
      db.close();
    }
  });

  it("fails closed before mutation when the backup directory is unusable", () => {
    const dir = tempDirs.make("openclaw-pre-migration-backup-");
    const dbPath = path.join(dir, "openclaw.sqlite");
    seedStateDb(dbPath, 5);
    fs.writeFileSync(path.join(dir, PRE_MIGRATION_BACKUP_DIRNAME), "occupied");
    const db = new DatabaseSync(dbPath);
    try {
      expect(() => createPreMigrationStateBackup(db, dbPath, 5, 6, Date.now())).toThrow(
        PreMigrationBackupError,
      );
      expect(
        (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
      ).toBe(5);
    } finally {
      db.close();
    }
  });
});

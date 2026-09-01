import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const BASELINE_VERSION = "2026.7.1-2";
const SCHEMA_VERSION = 1;
const AGENT_IDS = ["main", "ops"];

function requireEnv(name) {
  const value = process.env[name];
  assert(value, `${name} is required`);
  return value;
}

function agentDatabasePath(stateDir, agentId) {
  return path.join(stateDir, "agents", agentId, "agent", "openclaw-agent.sqlite");
}

function releasedDatabaseRelativePaths() {
  return [
    path.join("state", "openclaw.sqlite"),
    ...AGENT_IDS.map((agentId) => path.join("agents", agentId, "agent", "openclaw-agent.sqlite")),
  ];
}

function existingDatabaseFiles(stateDir) {
  const files = [];
  for (const relativePath of releasedDatabaseRelativePaths()) {
    for (const suffix of ["", "-wal", "-shm"]) {
      const candidate = path.join(stateDir, `${relativePath}${suffix}`);
      if (fs.existsSync(candidate)) {
        files.push(`${relativePath}${suffix}`);
      }
    }
  }
  return files;
}

function snapshotReleasedStores(snapshotDir, stateDir = requireEnv("OPENCLAW_STATE_DIR")) {
  fs.rmSync(snapshotDir, { recursive: true, force: true });
  const files = existingDatabaseFiles(stateDir);
  assert.equal(
    files.filter((file) => !file.endsWith("-wal") && !file.endsWith("-shm")).length,
    3,
    "expected shared state plus two released agent stores before snapshot",
  );
  for (const relativePath of files) {
    const target = path.join(snapshotDir, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(stateDir, relativePath), target);
  }
  process.stdout.write(`snapshotted ${files.length} released database files\n`);
}

function assertByteEqualRestoredStores(snapshotDir, restoredStateDir) {
  const snapshotFiles = existingDatabaseFiles(snapshotDir);
  assert(snapshotFiles.length >= 3, "snapshot is missing released database files");
  for (const relativePath of snapshotFiles) {
    const snapshotBytes = fs.readFileSync(path.join(snapshotDir, relativePath));
    const restoredPath = path.join(restoredStateDir, relativePath);
    assert(
      fs.existsSync(restoredPath),
      `restored state is missing ${relativePath} from the released snapshot`,
    );
    const restoredBytes = fs.readFileSync(restoredPath);
    assert(
      snapshotBytes.equals(restoredBytes),
      `restored ${relativePath} diverged from the released bytes ` +
        `(snapshot ${snapshotBytes.length}B, restored ${restoredBytes.length}B)`,
    );
  }
  process.stdout.write(
    `restored state matches ${snapshotFiles.length} released database files byte-for-byte\n`,
  );
}

function withDatabase(databasePath, operation) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return operation(database);
  } finally {
    database.close();
  }
}

function assertSchemaMetadata(database, expected) {
  assert.equal(database.prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION);
  const metadata = database
    .prepare("SELECT role, agent_id, schema_version FROM schema_meta WHERE meta_key = 'primary'")
    .get();
  assert.deepEqual({ ...metadata }, expected);
  assert.equal(database.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  assert.equal(database.prepare("PRAGMA foreign_key_check").all().length, 0);
}

async function seedReleasedStores(packageRoot) {
  const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  assert.equal(manifest.name, "openclaw");
  assert.equal(manifest.version, BASELINE_VERSION);

  // Build the fixture through the released implementation so its schema and
  // registry bytes stay tied to the package under test, not checkout source.
  const sqliteRuntime = await import(
    pathToFileURL(path.join(packageRoot, "dist", "plugin-sdk", "sqlite-runtime.js")).href
  );
  for (const agentId of AGENT_IDS) {
    const databasePath = sqliteRuntime.resolveOpenClawAgentSqlitePath({
      agentId,
      env: process.env,
    });
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const database = new DatabaseSync(databasePath);
    try {
      sqliteRuntime.ensureOpenClawAgentDatabaseSchema(database, {
        agentId,
        env: process.env,
        register: true,
      });
      database
        .prepare(
          "INSERT INTO cache_entries (scope, key, value_json, updated_at) VALUES (?, ?, ?, ?)",
        )
        .run(
          "upgrade-rollback",
          "sentinel",
          JSON.stringify({ agentId, release: BASELINE_VERSION }),
          1_753_958_400_000,
        );
    } finally {
      database.close();
    }
  }
}

function assertReleasedStores(stage, stateDir = requireEnv("OPENCLAW_STATE_DIR")) {
  const stateDatabasePath = path.join(stateDir, "state", "openclaw.sqlite");
  withDatabase(stateDatabasePath, (database) => {
    assertSchemaMetadata(database, {
      role: "global",
      agent_id: null,
      schema_version: SCHEMA_VERSION,
    });
    const registered = database
      .prepare("SELECT agent_id, schema_version FROM agent_databases ORDER BY agent_id")
      .all()
      .map((row) => Object.assign({}, row));
    assert.deepEqual(
      registered,
      AGENT_IDS.map((agentId) => ({ agent_id: agentId, schema_version: SCHEMA_VERSION })),
      `${stage}: released agent registry changed`,
    );
  });

  for (const agentId of AGENT_IDS) {
    withDatabase(agentDatabasePath(stateDir, agentId), (database) => {
      assertSchemaMetadata(database, {
        role: "agent",
        agent_id: agentId,
        schema_version: SCHEMA_VERSION,
      });
      const sentinel = database
        .prepare(
          "SELECT value_json FROM cache_entries WHERE scope = 'upgrade-rollback' AND key = 'sentinel'",
        )
        .get();
      assert.deepEqual(JSON.parse(sentinel?.value_json ?? "null"), {
        agentId,
        release: BASELINE_VERSION,
      });
    });
  }
}

function readUpdateReports(updatePath) {
  const output = fs.readFileSync(updatePath, "utf8");
  const jsonStart = output.indexOf("{");
  assert.notEqual(jsonStart, -1, "update reported no JSON result");
  return output
    .slice(jsonStart)
    .trim()
    .split(/\n(?=\{)/u)
    .map((value) => JSON.parse(value));
}

function readMigrationBackup(updatePath) {
  const report = readUpdateReports(updatePath).find((candidate) => candidate.migrationBackup);
  assert(report, "refused candidate activation omitted its pre-migration backup");
  const backup = report.migrationBackup;
  assert.equal(backup.verified, true, "candidate migration backup was not verified");
  assert.equal(backup.migrationStarted, true, "candidate refusal happened before migration began");
  assert(fs.statSync(backup.archivePath).isFile(), "candidate migration backup is missing");
  const transitions = backup.databases ?? [];
  assert(
    transitions.some((database) => database.kind === "state" && database.foundVersion === 1),
    "migration backup omitted the released shared-state transition",
  );
  for (const agentId of AGENT_IDS) {
    assert(
      transitions.some(
        (database) =>
          database.kind === "agent" && database.agentId === agentId && database.foundVersion === 1,
      ),
      `migration backup omitted agent ${agentId}`,
    );
  }
  return backup;
}

function assertCandidateRefusal(logPath) {
  const output = fs.readFileSync(logPath, "utf8");
  assert.match(
    output,
    /refus(?:ed|ing).*(?:gateway|ready)|plugin verification failed/isu,
    "candidate first activation did not record its readiness refusal",
  );
}

function assertRestoredBackup(restorePath, snapshotDir) {
  const restored = JSON.parse(fs.readFileSync(restorePath, "utf8"));
  assert.equal(restored.ok, true, "backup restore did not complete");
  const manifestPath = path.join(restored.targetPath, restored.archiveRoot, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const stateAsset = manifest.assets.find((asset) => asset.kind === "state");
  assert(stateAsset, "restored backup omitted the state asset");
  const restoredStateDir = path.join(restored.targetPath, stateAsset.archivePath);
  assertReleasedStores("restored backup", restoredStateDir);
  assertByteEqualRestoredStores(snapshotDir, restoredStateDir);
  process.stdout.write(`${restoredStateDir}\n`);
}

function printMigrationBackupPath(updatePath) {
  process.stdout.write(`${readMigrationBackup(updatePath).archivePath}\n`);
}

function assertMigrationBackup(updatePath) {
  readMigrationBackup(updatePath);
  process.stdout.write(
    "schema1 migration backup covers shared state and both registered agent stores\n",
  );
}

const [command, argument, extraArgument] = process.argv.slice(2);
if (command === "seed") {
  assert(argument, "seed requires the installed baseline package root");
  await seedReleasedStores(path.resolve(argument));
} else if (command === "assert-schema1") {
  assertReleasedStores(argument ?? "unknown stage");
} else if (command === "snapshot") {
  assert(argument, "snapshot requires the snapshot directory");
  snapshotReleasedStores(path.resolve(argument));
} else if (command === "assert-update-backup") {
  assert(argument, "assert-update-backup requires the update JSON");
  assertMigrationBackup(argument);
} else if (command === "assert-refusal") {
  assert(argument, "assert-refusal requires the candidate activation log");
  assertCandidateRefusal(argument);
} else if (command === "backup-path") {
  assert(argument, "backup-path requires the update JSON");
  printMigrationBackupPath(argument);
} else if (command === "assert-restored") {
  assert(argument, "assert-restored requires the restore JSON");
  assert(extraArgument, "assert-restored requires the released snapshot directory");
  assertRestoredBackup(argument, path.resolve(extraArgument));
} else {
  throw new Error(`unknown schema1 rollback command: ${command ?? "<missing>"}`);
}

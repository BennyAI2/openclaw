import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  PRE_MIGRATION_BACKUP_RETENTION,
  prunePreMigrationAgentBackups,
} from "./openclaw-state-pre-migration-backup.js";

const agentDbLog = createSubsystemLogger("state/agent-db");

export function pruneCompletedAgentMigrationBackups(pathname: string): void {
  const prunedPaths = prunePreMigrationAgentBackups(pathname);
  if (prunedPaths.length > 0) {
    agentDbLog.info(
      `Pruned ${prunedPaths.length} older pre-migration backup(s), keeping the newest ${PRE_MIGRATION_BACKUP_RETENTION}`,
    );
  }
}

import {
  resolveConfiguredAgentDatabaseCandidatePaths,
  resolveConfiguredAgentDatabaseTargets,
} from "../../config/sessions/targets.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  OPENCLAW_DATABASE_SCHEMA_DOCS_URL,
  preflightOpenClawDatabaseSchemas,
  type IncompatibleOpenClawDatabase,
  type IndeterminateOpenClawDatabase,
  type OpenClawDatabaseSchemaPreflight,
} from "../../state/openclaw-database-preflight.js";
import type { OpenClawSchemaVersions } from "../../state/openclaw-schema-versions.js";

export function formatSchemaRefusalLines(
  schemas: {
    incompatible: readonly IncompatibleOpenClawDatabase[];
    indeterminate: readonly IndeterminateOpenClawDatabase[];
  },
  dryRun = false,
): string[] {
  const prefix = dryRun ? "Would refuse update" : "Update refused";
  return [
    ...schemas.incompatible.map((database) => {
      const agent = database.agentId ? ` (agent ${database.agentId})` : "";
      return `${prefix}: ${database.kind} database${agent} ${database.path} has schema ${database.foundVersion}; target supports ${database.supportedVersion}; writer build ${database.writerAppVersion ?? "unknown"}.`;
    }),
    ...schemas.indeterminate.map(
      (database) =>
        `${prefix}: could not inspect ${database.kind} database ${database.path}: ${database.reason}; retry once the gateway releases it.`,
    ),
    OPENCLAW_DATABASE_SCHEMA_DOCS_URL,
    "Installing manually via npm bypasses this guard; back up first and verify compatibility.",
  ];
}

export function checkTargetDatabaseSchemas(
  supportedVersions: OpenClawSchemaVersions | undefined,
  context: { config: OpenClawConfig; env: NodeJS.ProcessEnv },
): OpenClawDatabaseSchemaPreflight {
  return supportedVersions
    ? preflightOpenClawDatabaseSchemas({
        env: context.env,
        supportedVersions,
        configuredAgentDatabaseTargets: (registeredDatabases) =>
          resolveConfiguredAgentDatabaseTargets(context.config, {
            env: context.env,
            registeredDatabases,
          }),
        configuredAgentDatabaseCandidatePaths: resolveConfiguredAgentDatabaseCandidatePaths(
          context.config,
          { env: context.env },
        ),
      })
    : { incompatible: [], indeterminate: [] };
}

export function hasSchemaRefusal(schemas: OpenClawDatabaseSchemaPreflight): boolean {
  return schemas.incompatible.length > 0 || schemas.indeterminate.length > 0;
}

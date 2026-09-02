import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PluginInstallRecord } from "../../src/config/types.plugins.js";
import { isTrustedOfficialPluginInstallRecord } from "../../src/plugins/official-external-install-records.js";

export type PluginInspectFixture = {
  plugin: {
    id: string;
    packageName: string;
    rootDir: string;
    trustedOfficialInstall: boolean;
  };
  install: PluginInstallRecord;
};

export function writePluginInspectFixture(
  binDir: string,
  records: Readonly<Record<string, PluginInstallRecord>>,
  mutate?: (inspections: Record<string, PluginInspectFixture>) => void,
): void {
  const inspections: Record<string, PluginInspectFixture> = {};
  for (const [pluginId, record] of Object.entries(records)) {
    if (!record.installPath || !existsSync(join(record.installPath, "package.json"))) {
      continue;
    }
    const { name: packageName } = JSON.parse(
      readFileSync(join(record.installPath, "package.json"), "utf8"),
    ) as { name: string };
    inspections[pluginId] = {
      plugin: {
        id: pluginId,
        packageName,
        rootDir: record.installPath,
        trustedOfficialInstall: isTrustedOfficialPluginInstallRecord({
          pluginId,
          packageName,
          record,
        }),
      },
      install: { ...record },
    };
  }
  mutate?.(inspections);
  mkdirSync(binDir, { recursive: true });
  const inspectionPath = join(binDir, "plugin-inspections.json");
  writeFileSync(inspectionPath, JSON.stringify(inspections));
  writeFileSync(
    join(binDir, "openclaw"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.join(" ") === "plugins install --help") {
  console.log("  --accept-capabilities  Accept capabilities");
} else if (args.length === 4 && args[0] === "plugins" && args[1] === "inspect" && args[3] === "--json") {
  const inspection = JSON.parse(fs.readFileSync(${JSON.stringify(inspectionPath)}, "utf8"))[args[2]];
  if (!inspection) process.exit(98);
  console.log(JSON.stringify(inspection));
} else {
  process.exit(97);
}
`,
    { mode: 0o755 },
  );
}

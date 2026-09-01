/**
 * Bundled channel runtime artifact resolver.
 *
 * Resolves generated contract artifacts through runtime records with local workspace fallback.
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import { listBundledChannelPluginMetadata } from "../../../../plugins/bundled-channel-runtime.js";
import { resolvePluginRootPublicSurfacePath } from "../../../../plugins/public-surface-runtime.js";
import { resolveRelativeBundledPluginPublicModuleId } from "../../../../test-utils/bundled-plugin-public-surface.js";

const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));

/** Loads a public source artifact when a host contract must mock its transport dependency. */
export async function importBundledChannelContractSourceArtifact<T extends object>(
  pluginId: string,
  artifactBasename: string,
): Promise<T> {
  const moduleId = resolveRelativeBundledPluginPublicModuleId({
    fromModuleUrl: import.meta.url,
    pluginId,
    artifactBasename,
  });
  return (await import(moduleId)) as T;
}

function resolveBundledChannelContractArtifactUrl(pluginId: string, entryBaseName: string): string {
  const normalizedEntryBaseName = entryBaseName.replace(/\.(?:[cm]?js|ts)$/u, "");
  const metadata = listBundledChannelPluginMetadata({
    rootDir: REPO_ROOT,
    includeChannelConfigs: false,
    includeSyntheticChannelConfigs: false,
  }).find((entry) => entry.manifest.id === pluginId);
  if (!metadata) {
    throw new Error(`missing bundled channel plugin '${pluginId}'`);
  }
  const modulePath = resolvePluginRootPublicSurfacePath({
    pluginRoot: metadata.rootDir,
    pluginId,
    entrySource: metadata.source.built,
    artifactBasename: `${normalizedEntryBaseName}.js`,
  });
  if (!modulePath) {
    throw new Error(`missing ${entryBaseName} for bundled channel plugin '${pluginId}'`);
  }
  return pathToFileURL(modulePath).href;
}

/** Imports a generated bundled channel artifact through the contract boundary. */
export async function importBundledChannelContractArtifact<T extends object>(
  pluginId: string,
  entryBaseName: string,
): Promise<T> {
  return (await import(resolveBundledChannelContractArtifactUrl(pluginId, entryBaseName))) as T;
}

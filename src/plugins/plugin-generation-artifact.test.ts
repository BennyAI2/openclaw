import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { capturePluginGenerationArtifact } from "./plugin-generation-artifact.js";
import { createPluginModuleHost } from "./plugin-module-host.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    cleanup();
  }
});

it("captures a standalone file's imports and assets without owning its parent workspace", async () => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-file-"));
  cleanups.push(() => fs.rmSync(source, { recursive: true, force: true }));
  const socket = process.platform === "win32" ? undefined : net.createServer();
  if (socket) {
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.listen(path.join(source, "socket"), resolve);
    });
  }
  try {
    fs.writeFileSync(path.join(source, "unrelated.txt"), "private workspace content");
    fs.mkdirSync(path.join(source, "unrelated"));
    fs.writeFileSync(path.join(source, "unrelated", "private.txt"), "private workspace content");
    fs.writeFileSync(
      path.join(source, "index.ts"),
      `import { token } from '@openclaw/plugin-sdk/fixture'; export { token };
       export const description = './unrelated'; export const read = async () => (await import('./helper.js')).read();`,
    );
    fs.writeFileSync(
      path.join(source, "helper.ts"),
      `import fs from 'node:fs'; export const read = () => fs.readFileSync(new URL('./asset.txt', import.meta.url), 'utf8');`,
    );
    fs.writeFileSync(path.join(source, "asset.txt"), "before");
    const entry = path.join(source, "index.ts");
    const captured = capturePluginGenerationArtifact(source, entry);
    cleanups.push(captured.dispose);
    const token = {};
    const requireHost = createRequire(import.meta.url);
    const host = createPluginModuleHost({
      pluginId: "file",
      rootDir: captured.boundaryRoot,
      loadHostModule: (specifier) =>
        specifier === "@openclaw/plugin-sdk/fixture" ? { token } : requireHost(specifier),
    });
    cleanups.push(host.dispose);
    const plugin = host.load(captured.resolve(entry)) as {
      read(): Promise<string>;
      token: unknown;
    };
    expect(plugin.token).toBe(token);
    fs.writeFileSync(path.join(source, "asset.txt"), "after");
    fs.writeFileSync(path.join(source, "helper.ts"), `export const read = () => 'changed helper';`);
    await expect(plugin.read()).resolves.toBe("before");
    expect(fs.readdirSync(captured.rootDir).toSorted()).toEqual([
      "asset.txt",
      "helper.ts",
      "index.ts",
    ]);
    expect(captured.hasSource(path.join(source, "unrelated.txt"))).toBe(false);
  } finally {
    if (socket) {
      await new Promise<void>((resolve, reject) => {
        socket.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }
});

it("captures TypeScript helpers and lazy assets for each reload and releases its build files", async () => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-source-"));
  cleanups.push(() => fs.rmSync(source, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(source, "index.ts"),
    `import { value } from './helper.js'; export const read = async () => [value, (await import('./lazy.js')).read()];`,
  );
  fs.writeFileSync(path.join(source, "helper.js"), `export const value = 'stale build';`);
  fs.writeFileSync(
    path.join(source, "lazy.ts"),
    `import fs from 'node:fs'; export const read = () => fs.readFileSync(new URL('./asset.txt', import.meta.url), 'utf8');`,
  );
  const load = (value: string) => {
    fs.writeFileSync(path.join(source, "helper.ts"), `export const value = '${value}';`);
    fs.writeFileSync(path.join(source, "asset.txt"), value);
    const artifact = capturePluginGenerationArtifact(source);
    cleanups.push(artifact.dispose);
    const host = createPluginModuleHost({
      pluginId: "fixture",
      rootDir: artifact.boundaryRoot,
      loadHostModule: createRequire(import.meta.url),
    });
    cleanups.push(host.dispose);
    const plugin = host.load(artifact.resolve(path.join(source, "index.ts"))) as {
      read: () => Promise<string[]>;
    };
    return { artifact, host, plugin };
  };
  const a = load("A");
  const b = load("B");
  await expect(a.plugin.read()).resolves.toEqual(["A", "A"]);
  await expect(b.plugin.read()).resolves.toEqual(["B", "B"]);
  expect(a.artifact.sourceDigest).not.toBe(b.artifact.sourceDigest);
  fs.rmSync(source, { recursive: true });
  expect(b.artifact.resolve(path.join(source, "lazy.ts"))).toBe(
    path.join(b.artifact.rootDir, "lazy.ts"),
  );
  a.host.dispose();
  a.artifact.dispose();
  expect(fs.existsSync(a.artifact.boundaryRoot)).toBe(false);
  await expect(b.plugin.read()).resolves.toEqual(["B", "B"]);
});

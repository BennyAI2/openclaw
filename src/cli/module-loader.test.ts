import { describe, expect, it, vi } from "vitest";
import { createCliModuleLoader } from "./module-loader.js";

describe("createCliModuleLoader", () => {
  it("invokes synchronously and returns the importer promise", () => {
    const imported = Promise.resolve({ value: 1 });
    const importer = vi.fn(() => imported);
    const load = createCliModuleLoader(importer);

    const first = load();

    expect(importer).toHaveBeenCalledTimes(1);
    expect(first).toBe(imported);
    expect(load()).toBe(imported);
    expect(importer).toHaveBeenCalledTimes(1);
  });

  it("keeps a rejected importer promise", async () => {
    const error = new Error("import failed");
    const imported = Promise.reject(error);
    const importer = vi.fn(() => imported);
    const load = createCliModuleLoader(importer);

    const first = load();

    await expect(first).rejects.toBe(error);
    expect(load()).toBe(first);
    await expect(load()).rejects.toBe(error);
    expect(importer).toHaveBeenCalledTimes(1);
  });
});

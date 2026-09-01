import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGithubIssue, createPrefilledGithubIssueUrl } from "./github-issue.js";

describe("createGithubIssue default GitHub CLI spawn", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns a prefilled handoff when gh is absent from PATH", async () => {
    const emptyPath = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-no-gh-"));
    try {
      vi.stubEnv("PATH", emptyPath);
      const title = "Update failure: test";
      const body = "sanitized body";
      const fallbackUrl = createPrefilledGithubIssueUrl(title, body);

      const result = createGithubIssue({ body, title, url: fallbackUrl });

      expect(result).toMatchObject({ fallbackUrl, ok: false });
      expect(result.ok ? "" : result.message).toContain("ENOENT");
    } finally {
      await fs.rm(emptyPath, { force: true, recursive: true });
    }
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGithubIssue } from "./github-issue.js";

const spawnSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawnSync: spawnSyncMock };
});

describe("createGithubIssue", () => {
  beforeEach(() => {
    spawnSyncMock.mockReset();
    vi.stubEnv("VITEST", undefined);
    vi.stubEnv("NODE_ENV", undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ["VITEST", "true"],
    ["NODE_ENV", "test"],
  ])("blocks the default GitHub CLI transport when %s marks a test process", (key, value) => {
    vi.stubEnv(key, value);
    const fallbackUrl = "https://github.com/openclaw/openclaw/issues/new?title=update";

    expect(
      createGithubIssue({
        body: "sanitized body",
        title: "Update failed",
        url: fallbackUrl,
      }),
    ).toEqual({
      fallbackUrl,
      message: "External GitHub issue creation is disabled in test processes.",
      ok: false,
    });
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("returns the issue URL after a successful authenticated CLI submission", () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      stderr: Buffer.alloc(0),
      stdout: Buffer.from("https://github.com/openclaw/openclaw/issues/123\n"),
    });

    expect(
      createGithubIssue({
        body: "sanitized body",
        title: "Update failed",
        url: "https://github.com/openclaw/openclaw/issues/new?title=update",
      }),
    ).toEqual({ ok: true, url: "https://github.com/openclaw/openclaw/issues/123" });
  });

  it("does not expose an unexpected successful CLI output as a browser link", () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      stderr: Buffer.alloc(0),
      stdout: Buffer.from("javascript:alert(1)\n"),
    });

    expect(
      createGithubIssue({
        body: "sanitized body",
        title: "Update failed",
        url: "https://github.com/openclaw/openclaw/issues/new?title=update",
      }),
    ).toEqual({ ok: true, url: "https://github.com/openclaw/openclaw/issues" });
  });

  it("bounds GitHub CLI issue creation and preserves the fallback URL on timeout", () => {
    const timeoutError = Object.assign(new Error("spawnSync gh ETIMEDOUT"), {
      code: "ETIMEDOUT",
    });
    spawnSyncMock.mockReturnValue({
      error: timeoutError,
      status: null,
      stderr: Buffer.alloc(0),
      stdout: Buffer.alloc(0),
    });

    const result = createGithubIssue({
      body: "sanitized body",
      title: "Session SQLite migration recovery report",
      url: "https://github.com/openclaw/openclaw/issues/new?title=recovery",
    });

    expect(spawnSyncMock).toHaveBeenCalledWith(
      "gh",
      [
        "issue",
        "create",
        "--repo",
        "openclaw/openclaw",
        "--title",
        "Session SQLite migration recovery report",
        "--body-file",
        "-",
      ],
      {
        input: "sanitized body",
        killSignal: "SIGKILL",
        maxBuffer: 1024 * 1024,
        timeout: 30_000,
      },
    );
    expect(result).toEqual({
      fallbackUrl: "https://github.com/openclaw/openclaw/issues/new?title=recovery",
      message: "spawnSync gh ETIMEDOUT",
      ok: false,
    });
  });

  it.each([
    {
      label: "missing gh",
      result: {
        error: Object.assign(new Error("spawnSync gh ENOENT"), { code: "ENOENT" }),
        status: null,
        stderr: Buffer.alloc(0),
        stdout: Buffer.alloc(0),
      },
      message: "spawnSync gh ENOENT",
    },
    {
      label: "unauthenticated gh",
      result: {
        status: 4,
        stderr: Buffer.from("To get started with GitHub CLI, run: gh auth login"),
        stdout: Buffer.alloc(0),
      },
      message: "To get started with GitHub CLI, run: gh auth login",
    },
  ])("returns the prefilled handoff for $label", ({ result, message }) => {
    spawnSyncMock.mockReturnValue(result);
    const fallbackUrl = "https://github.com/openclaw/openclaw/issues/new?title=update";

    expect(
      createGithubIssue({ body: "sanitized body", title: "Update failed", url: fallbackUrl }),
    ).toEqual({ fallbackUrl, message, ok: false });
  });
});

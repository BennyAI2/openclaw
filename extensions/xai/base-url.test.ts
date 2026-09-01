import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveXaiBaseUrl } from "./base-url.js";
import { XAI_BASE_URL } from "./model-definitions.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveXaiBaseUrl", () => {
  it("uses the canonical default without explicit or environment input", () => {
    vi.stubEnv("XAI_BASE_URL", undefined);

    expect(resolveXaiBaseUrl()).toBe(XAI_BASE_URL);
  });

  it("trims the environment URL", () => {
    vi.stubEnv("XAI_BASE_URL", "  https://env.example/v1  ");

    expect(resolveXaiBaseUrl()).toBe("https://env.example/v1");
  });

  it("trims and prefers the explicit URL", () => {
    vi.stubEnv("XAI_BASE_URL", "https://env.example/v1");

    expect(resolveXaiBaseUrl("  https://config.example/v1  ")).toBe("https://config.example/v1");
  });

  it("uses the canonical default when blank explicit input suppresses the environment", () => {
    vi.stubEnv("XAI_BASE_URL", "https://env.example/v1");

    expect(resolveXaiBaseUrl(" \t ")).toBe(XAI_BASE_URL);
  });
});

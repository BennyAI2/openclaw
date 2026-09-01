import { describe, expect, it, vi } from "vitest";
import type { MigrationProviderPlugin, ProviderAuthMethod } from "../../plugins/types.js";

const mocks = vi.hoisted(() => ({ tryResolveMigrationProvider: vi.fn() }));

vi.mock("../migrate/providers.js", () => ({
  tryResolveMigrationProvider: mocks.tryResolveMigrationProvider,
}));

const { tryImportProviderCredential } = await import("./auth-credential-import.js");

const method: ProviderAuthMethod = {
  id: "device-code",
  label: "Device login",
  kind: "device_code",
  credentialImport: {
    migrationProviderId: "codex",
    itemId: "auth:openai",
    credentialKind: "oauth",
  },
  run: vi.fn(),
};

function migrationProvider(params: {
  plan: MigrationProviderPlugin["plan"];
  apply?: MigrationProviderPlugin["apply"];
}): MigrationProviderPlugin {
  return {
    id: "codex",
    label: "Codex",
    plan: params.plan,
    apply:
      params.apply ??
      (async (_ctx, plan) => {
        if (!plan) {
          throw new Error("expected selected migration plan");
        }
        return plan;
      }),
  };
}

describe("tryImportProviderCredential", () => {
  it("applies one matching OAuth item after locking the persistent effect", async () => {
    const order: string[] = [];
    const provider = migrationProvider({
      plan: async (ctx) => {
        expect(ctx.itemKinds).toEqual(["auth"]);
        expect(ctx.includeSecrets).toBe(true);
        expect(ctx.providerOptions).toEqual({ configPatchMode: "return" });
        return {
          providerId: "codex",
          source: "/tmp/codex",
          summary: {
            total: 2,
            planned: 2,
            migrated: 0,
            skipped: 0,
            conflicts: 0,
            errors: 0,
            sensitive: 1,
          },
          items: [
            {
              id: "auth:openai",
              kind: "auth",
              action: "create",
              status: "planned",
              details: {
                profileId: "openai:account-owner",
                provider: "openai",
                credentialKind: "oauth",
              },
            },
            { id: "skill:ignore", kind: "skill", action: "copy", status: "planned" },
          ],
        };
      },
      apply: async (_ctx, plan) => {
        order.push("apply");
        expect(plan?.items.find((item) => item.id === "skill:ignore")?.status).toBe("skipped");
        const authItem = plan?.items.find((item) => item.id === "auth:openai");
        if (!plan || !authItem) {
          throw new Error("expected selected auth item");
        }
        return {
          ...plan,
          items: [{ ...authItem, status: "migrated" }],
        };
      },
    });
    mocks.tryResolveMigrationProvider.mockReturnValue(provider);

    const result = await tryImportProviderCredential({
      method,
      config: { agents: { list: [{ id: "main", default: true }] } },
      agentId: "main",
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      credentialOnly: true,
      beforePersistentEffect: () => {
        order.push("lock");
      },
    });

    expect(order).toEqual(["lock", "apply"]);
    expect(result).toEqual({
      profileId: "openai:account-owner",
      provider: "openai",
      mode: "oauth",
      configUpdated: false,
    });
  });

  it("continues to interactive login when no matching credential exists", async () => {
    const beforePersistentEffect = vi.fn();
    mocks.tryResolveMigrationProvider.mockReturnValue(
      migrationProvider({
        plan: async () => ({
          providerId: "codex",
          source: "/tmp/codex",
          summary: {
            total: 0,
            planned: 0,
            migrated: 0,
            skipped: 0,
            conflicts: 0,
            errors: 0,
            sensitive: 0,
          },
          items: [],
        }),
      }),
    );

    await expect(
      tryImportProviderCredential({
        method,
        config: { agents: { list: [{ id: "main", default: true }] } },
        agentId: "main",
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        beforePersistentEffect,
      }),
    ).resolves.toBeUndefined();
    expect(beforePersistentEffect).not.toHaveBeenCalled();
  });
});

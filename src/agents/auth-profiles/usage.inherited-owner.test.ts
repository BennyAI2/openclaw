import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resetFileLockStateForTest } from "../../infra/file-lock.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  connectUserModelAccount,
  readUserModelAuthProfile,
} from "../../state/user-model-accounts.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { captureEnv, setTestEnvValue } from "../../test-utils/env.js";
import { resolveAuthProfileOrder } from "./order.js";
import { loadPersistedAuthProfileStore } from "./persisted.js";
import { markAuthProfileSuccess, removeAuthProfilesWithLock } from "./profiles.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  replaceRuntimeAuthProfileStoreSnapshots,
  setRuntimeAuthProfileStoreSnapshot,
} from "./runtime-snapshots.js";
import {
  ensureAuthProfileStore,
  findPersistedAuthProfileCredential,
  saveAuthProfileStore,
  withAuthProfileStoreAgentDir,
  withEnvOnlyAuthProfileStore,
} from "./store.js";
import type { AuthProfileStore } from "./types.js";
import {
  clearAuthProfileCooldown,
  markAuthProfileBlockedUntil,
  markAuthProfileFailure,
} from "./usage.js";

const PRIMARY_ID = "openai:primary";
const BACKUP_ID = "openai:backup";
const LOCAL_ID = "openai:local";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createMainStore(): AuthProfileStore {
  const expires = Date.now() + 30 * 60 * 1000;
  return {
    version: 1,
    profiles: {
      [PRIMARY_ID]: {
        type: "oauth",
        provider: "openai",
        access: "primary-access",
        refresh: "primary-refresh",
        expires,
      },
      [BACKUP_ID]: {
        type: "oauth",
        provider: "openai",
        access: "backup-access",
        refresh: "backup-refresh",
        expires,
      },
    },
    order: { openai: [PRIMARY_ID, BACKUP_ID] },
  };
}

describe("inherited auth-profile usage persistence", () => {
  const env = captureEnv(["OPENCLAW_STATE_DIR", "OPENCLAW_AGENT_DIR"]);
  let rootDir: string;
  let mainAgentDir: string;
  let childAgentDir: string;

  beforeEach(() => {
    resetFileLockStateForTest();
    rootDir = tempDirs.make("inherited-auth-owner-");
    mainAgentDir = path.join(rootDir, "agents", "main", "agent");
    childAgentDir = path.join(rootDir, "agents", "child", "agent");
    fs.mkdirSync(mainAgentDir, { recursive: true });
    fs.mkdirSync(childAgentDir, { recursive: true });
    setTestEnvValue("OPENCLAW_STATE_DIR", rootDir);
    setTestEnvValue("OPENCLAW_AGENT_DIR", mainAgentDir);
    clearRuntimeAuthProfileStoreSnapshots();
  });

  afterEach(() => {
    clearRuntimeAuthProfileStoreSnapshots();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    resetFileLockStateForTest();
    env.restore();
  });

  function writeMainStore(): void {
    saveAuthProfileStore(createMainStore(), mainAgentDir, {
      filterExternalAuthProfiles: false,
      syncExternalCli: false,
    });
  }

  function connectPersonalAccount(email: string): string {
    const owner = ensureProfileForEmail(email);
    return connectUserModelAccount({
      ownerProfileId: owner.id,
      credential: { type: "token", provider: "anthropic", token: "synthetic-personal-token" },
      assertCurrent() {},
    }).authProfileId;
  }

  it("keeps selected personal health in its owner without publishing credentials or selection", async () => {
    writeMainStore();
    const aliceId = connectPersonalAccount("alice@example.test");
    const bobId = connectPersonalAccount("bob@example.test");
    const turnStore = ensureAuthProfileStore(childAgentDir, { profileId: aliceId });
    expect(turnStore.profiles[aliceId]?.provider).toBe("anthropic");
    expect(turnStore.profiles[bobId]).toBeUndefined();

    await markAuthProfileFailure({
      store: turnStore,
      profileId: aliceId,
      reason: "timeout",
      agentDir: childAgentDir,
    });
    expect(readUserModelAuthProfile(aliceId)?.usageStats?.cooldownUntil).toBeTypeOf("number");
    await markAuthProfileSuccess({
      store: turnStore,
      profileId: aliceId,
      provider: "anthropic",
      agentDir: childAgentDir,
    });
    expect(readUserModelAuthProfile(aliceId)?.usageStats).toMatchObject({
      errorCount: 0,
      lastUsed: expect.any(Number),
    });
    expect(readUserModelAuthProfile(aliceId)?.usageStats?.cooldownUntil).toBeUndefined();
    expect(loadPersistedAuthProfileStore(mainAgentDir)?.usageStats?.[aliceId]).toBeUndefined();

    turnStore.order = { ...turnStore.order, anthropic: [aliceId] };
    turnStore.lastGood = { anthropic: aliceId };
    saveAuthProfileStore(turnStore, childAgentDir, {
      filterExternalAuthProfiles: false,
      preserveOrderProfileIds: [aliceId],
      preserveStateProfileIds: [aliceId],
    });
    const persistedChild = loadPersistedAuthProfileStore(childAgentDir);
    expect(persistedChild?.profiles[aliceId]).toBeUndefined();
    expect(persistedChild?.usageStats?.[aliceId]).toBeUndefined();
    expect(persistedChild?.order?.anthropic).toBeUndefined();
    expect(persistedChild?.lastGood?.anthropic).toBeUndefined();

    setRuntimeAuthProfileStoreSnapshot(turnStore, childAgentDir);
    expect(ensureAuthProfileStore(childAgentDir).profiles[aliceId]).toBeUndefined();
    replaceRuntimeAuthProfileStoreSnapshots([{ agentDir: childAgentDir, store: turnStore }]);
    expect(ensureAuthProfileStore(childAgentDir).profiles[aliceId]).toBeUndefined();
  });

  it("does not carry personal credentials into isolated auth scopes", () => {
    const personalId = connectPersonalAccount("alice@example.test");
    expect(
      withEnvOnlyAuthProfileStore(
        () => ensureAuthProfileStore(childAgentDir, { profileId: personalId }).profiles[personalId],
      ),
    ).toBeUndefined();
    withAuthProfileStoreAgentDir(childAgentDir, rootDir, () => {
      expect(
        ensureAuthProfileStore(childAgentDir, { profileId: personalId }).profiles[personalId],
      ).toBeUndefined();
      expect(
        findPersistedAuthProfileCredential({ agentDir: childAgentDir, profileId: personalId }),
      ).toBeUndefined();
    });
  });

  it("rejects personal account removal through the shared CLI boundary without deleting shared profiles", async () => {
    writeMainStore();
    const personalId = connectPersonalAccount("alice@example.test");

    await expect(
      removeAuthProfilesWithLock({
        agentDir: mainAgentDir,
        profileIds: [PRIMARY_ID, personalId],
      }),
    ).rejects.toThrow("Personal model accounts are managed in Settings");
    expect(loadPersistedAuthProfileStore(mainAgentDir)?.profiles[PRIMARY_ID]).toBeDefined();
    expect(readUserModelAuthProfile(personalId)?.credential).toBeDefined();
  });

  it("keeps an inherited primary blocked for the next child run", async () => {
    writeMainStore();
    const localCooldownUntil = Date.now() + 30 * 60 * 1000;
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [LOCAL_ID]: { type: "api_key", provider: "openai", key: "local-key" },
        },
        usageStats: { [LOCAL_ID]: { cooldownUntil: localCooldownUntil } },
      },
      childAgentDir,
      { filterExternalAuthProfiles: false, syncExternalCli: false },
    );
    const childStore = ensureAuthProfileStore(childAgentDir);
    const blockedUntil = Date.now() + 60 * 60 * 1000;

    await markAuthProfileBlockedUntil({
      store: childStore,
      profileId: PRIMARY_ID,
      blockedUntil,
      source: "codex_rate_limits",
      agentDir: childAgentDir,
      modelId: "gpt-5.6-sol",
    });

    expect(childStore.usageStats?.[LOCAL_ID]?.cooldownUntil).toBe(localCooldownUntil);
    const persistedChild = loadPersistedAuthProfileStore(childAgentDir);
    expect(persistedChild?.profiles[PRIMARY_ID]).toBeUndefined();
    expect(persistedChild?.usageStats?.[LOCAL_ID]?.cooldownUntil).toBe(localCooldownUntil);

    clearRuntimeAuthProfileStoreSnapshots();
    const nextRunStore = ensureAuthProfileStore(childAgentDir);
    expect({
      ownerBlockedUntil:
        loadPersistedAuthProfileStore(mainAgentDir)?.usageStats?.[PRIMARY_ID]?.blockedUntil,
      nextRunOrder: resolveAuthProfileOrder({ store: nextRunStore, provider: "openai" }),
    }).toEqual({
      ownerBlockedUntil: blockedUntil,
      nextRunOrder: [BACKUP_ID, LOCAL_ID, PRIMARY_ID],
    });
  });

  it("writes and clears inherited failure state in the owner store", async () => {
    writeMainStore();
    const childStore = ensureAuthProfileStore(childAgentDir);

    await markAuthProfileFailure({
      store: childStore,
      profileId: PRIMARY_ID,
      reason: "timeout",
      agentDir: childAgentDir,
    });
    expect(
      loadPersistedAuthProfileStore(mainAgentDir)?.usageStats?.[PRIMARY_ID]?.cooldownUntil,
    ).toBeTypeOf("number");

    await clearAuthProfileCooldown({
      store: childStore,
      profileId: PRIMARY_ID,
      agentDir: childAgentDir,
    });
    const ownerStats = loadPersistedAuthProfileStore(mainAgentDir)?.usageStats?.[PRIMARY_ID];
    expect(ownerStats?.cooldownUntil).toBeUndefined();
    expect(ownerStats?.errorCount).toBe(0);
  });

  it("clears inherited health without changing selection ownership", async () => {
    const lastUsed = Date.now() - 60_000;
    const mainStore = createMainStore();
    mainStore.lastGood = { openai: BACKUP_ID };
    mainStore.usageStats = {
      [PRIMARY_ID]: {
        lastUsed,
        errorCount: 2,
        cooldownUntil: Date.now() + 60_000,
        cooldownReason: "rate_limit",
        cooldownClassification: "wham_token_expired",
      },
    };
    saveAuthProfileStore(mainStore, mainAgentDir, {
      filterExternalAuthProfiles: false,
      syncExternalCli: false,
    });
    const localCooldownUntil = Date.now() + 30_000;
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [LOCAL_ID]: { type: "api_key", provider: "openai", key: "local-key" },
        },
        usageStats: { [LOCAL_ID]: { cooldownUntil: localCooldownUntil } },
      },
      childAgentDir,
      { filterExternalAuthProfiles: false, syncExternalCli: false },
    );
    const childStore = ensureAuthProfileStore(childAgentDir);

    await markAuthProfileSuccess({
      store: childStore,
      provider: "openai",
      profileId: PRIMARY_ID,
      agentDir: childAgentDir,
    });

    const persistedMain = loadPersistedAuthProfileStore(mainAgentDir);
    expect(persistedMain?.lastGood?.openai).toBe(BACKUP_ID);
    expect(persistedMain?.usageStats?.[PRIMARY_ID]).toMatchObject({
      lastUsed,
      errorCount: 0,
    });
    expect(persistedMain?.usageStats?.[PRIMARY_ID]?.cooldownUntil).toBeUndefined();
    expect(persistedMain?.usageStats?.[PRIMARY_ID]?.cooldownClassification).toBeUndefined();
    expect(childStore.usageStats?.[LOCAL_ID]?.cooldownUntil).toBe(localCooldownUntil);
    expect(childStore.usageStats?.[PRIMARY_ID]?.cooldownUntil).toBeUndefined();
    const persistedChild = loadPersistedAuthProfileStore(childAgentDir);
    expect(persistedChild?.profiles[PRIMARY_ID]).toBeUndefined();
    expect(persistedChild?.usageStats?.[PRIMARY_ID]).toBeUndefined();
    expect(persistedChild?.lastGood?.openai).toBeUndefined();
  });
});

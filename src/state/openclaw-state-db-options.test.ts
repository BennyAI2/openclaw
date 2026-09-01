import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { openClawStateDatabaseOptionsForStateDir } from "./openclaw-state-db.js";

const AMBIENT_KEY = "OPENCLAW_STATE_DB_OPTIONS_TEST_VALUE";
let envSnapshot: ReturnType<typeof captureEnv>;

beforeEach(() => {
  envSnapshot = captureEnv(["OPENCLAW_STATE_DIR", AMBIENT_KEY]);
});

afterEach(() => {
  envSnapshot.restore();
});

describe("openClawStateDatabaseOptionsForStateDir", () => {
  it.each([
    { label: "undefined", stateDir: undefined },
    { label: "empty", stateDir: "" },
  ])("reuses process.env for $label state directories", ({ stateDir }) => {
    expect(openClawStateDatabaseOptionsForStateDir(stateDir).env).toBe(process.env);
  });

  it("overrides a non-empty state directory without mutating process.env", () => {
    setTestEnvValue("OPENCLAW_STATE_DIR", "ambient-state");

    const options = openClawStateDatabaseOptionsForStateDir("explicit-state");

    expect(options.env).not.toBe(process.env);
    expect(options.env?.OPENCLAW_STATE_DIR).toBe("explicit-state");
    expect(process.env.OPENCLAW_STATE_DIR).toBe("ambient-state");
  });

  it("snapshots ambient values for each non-empty state directory call", () => {
    setTestEnvValue(AMBIENT_KEY, "first");
    const first = openClawStateDatabaseOptionsForStateDir("first-state");
    setTestEnvValue(AMBIENT_KEY, "second");
    const second = openClawStateDatabaseOptionsForStateDir("second-state");

    expect(first.env).not.toBe(second.env);
    expect(first.env?.[AMBIENT_KEY]).toBe("first");
    expect(second.env?.[AMBIENT_KEY]).toBe("second");
    expect(first.env?.OPENCLAW_STATE_DIR).toBe("first-state");
    expect(second.env?.OPENCLAW_STATE_DIR).toBe("second-state");
  });
});

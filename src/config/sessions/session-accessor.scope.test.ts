import { expect, it } from "vitest";
import { toSessionAccessScope } from "./session-accessor.scope.js";

it("projects only caller-facing scope fields", () => {
  const env = { OPENCLAW_STATE_DIR: "/tmp/openclaw-state" };
  const inheritedParams = Object.assign(Object.create({ agentId: "ops" }), {
    env,
    hydrateSkillPromptRefs: false,
    readConsistency: "latest" as const,
    sessionKey: "",
    storePath: "",
  });

  expect(toSessionAccessScope(inheritedParams)).toStrictEqual({
    sessionKey: "",
    agentId: "ops",
    env,
    hydrateSkillPromptRefs: false,
    readConsistency: "latest",
    storePath: "",
  });

  const forbiddenReads: PropertyKey[] = [];
  const proxyValues = { agentId: "worker", hydrateSkillPromptRefs: false } as const;
  const proxyParams = new Proxy(
    { clone: false, defaultAgentId: "main", extra: "private", sessionKey: "session" },
    {
      get(target, property, receiver) {
        if (property === "clone" || property === "defaultAgentId" || property === "extra") {
          forbiddenReads.push(property);
        }
        return property in proxyValues
          ? proxyValues[property as keyof typeof proxyValues]
          : Reflect.get(target, property, receiver);
      },
    },
  );

  expect(toSessionAccessScope(proxyParams)).toStrictEqual({
    sessionKey: "session",
    agentId: "worker",
    hydrateSkillPromptRefs: false,
  });
  expect(forbiddenReads).toStrictEqual([]);
});

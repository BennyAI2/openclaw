// Discord tests cover allow list plugin behavior.
import { describe, expect, it } from "vitest";
import {
  normalizeDiscordDisplaySlug,
  normalizeDiscordDmOwnerEntry,
  normalizeDiscordSlug,
} from "./allow-list.js";

describe("discord DM owner normalization", () => {
  it.each([
    ["123", "123"],
    [" 123 ", "123"],
    ["<@123>", "123"],
    ["<@!123>", "123"],
    ["discord:123", "123"],
    ["user:123", "123"],
    ["pk:123", "123"],
    ["*", undefined],
    ["alice", undefined],
    ["", undefined],
    ["   ", undefined],
    ["discord:alice", undefined],
    ["user:", undefined],
    ["pk:abc", undefined],
    ["discord:123:user:456", undefined],
  ])("normalizes %j to %j", (entry, expected) => {
    expect(normalizeDiscordDmOwnerEntry(entry)).toBe(expected);
  });
});

describe("discord slug normalization", () => {
  it("keeps config slugs ASCII-only", () => {
    expect(normalizeDiscordSlug("\uC2E4\uD5D8")).toBe("");
    expect(normalizeDiscordSlug("baseline-\uAC80\uC99D")).toBe("baseline");
  });

  it("preserves Unicode in display slugs", () => {
    expect(normalizeDiscordDisplaySlug("\uC2E4\uD5D8")).toBe("\uC2E4\uD5D8");
    expect(normalizeDiscordDisplaySlug("baseline-\uAC80\uC99D")).toBe("baseline-\uAC80\uC99D");
  });
});

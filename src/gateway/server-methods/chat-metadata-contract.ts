export type ChatMetadataSessionEntry = {
  authProfileOverride?: string;
  authProfileOverrideSource?: "auto" | "user" | "user-link";
  authProfileOverrideCompactionCount?: number;
};

export type ChatMetadataReadParams = {
  agentId: string;
  requesterProfileId?: string;
  sessionEntry?: ChatMetadataSessionEntry;
};

export type ChatMetadataResult = {
  commands?: unknown[];
  models?: unknown[];
  swarmEnabled: boolean;
};

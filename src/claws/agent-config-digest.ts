import type { AgentConfig } from "../config/types.agents.js";
import { digestClawCanonicalValue } from "./canonical-value-digest.js";

export function digestClawAgentConfig(agent: AgentConfig): string {
  return digestClawCanonicalValue(agent);
}

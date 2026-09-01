import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { AttemptParamsLike } from "./attempt-types.js";

type TranscriptRecorder = NonNullable<AttemptParamsLike["userTurnTranscriptRecorder"]>;
type AttemptUserMessage = NonNullable<TranscriptRecorder["message"]>;
export type AttemptTranscriptMessage =
  | AttemptUserMessage
  | Extract<AgentMessage, { role: "assistant" | "toolResult" }>;

function readAssistantToolCallIds(message: AttemptTranscriptMessage): string[] {
  return message.role === "assistant"
    ? message.content.flatMap((part) => (part.type === "toolCall" ? [part.id] : []))
    : [];
}

export function matchesAttemptUser(
  candidate: AgentMessage | undefined,
  expected: AttemptUserMessage,
  currentRunUserKey: string,
): boolean {
  if (candidate?.role !== "user") {
    return false;
  }
  if (candidate === expected) {
    return true;
  }
  // SAFETY: AgentMessage variants may carry the journal's optional private identity field.
  const candidateKey = (candidate as { idempotencyKey?: unknown }).idempotencyKey;
  // SAFETY: Recorder-owned user messages may carry the same private identity field.
  const expectedKey = (expected as { idempotencyKey?: unknown }).idempotencyKey;
  if (typeof candidateKey === "string" || typeof expectedKey === "string") {
    if (typeof candidateKey === "string" && typeof expectedKey === "string") {
      return candidateKey === expectedKey;
    }
    if (
      typeof candidateKey !== "string" ||
      typeof expectedKey === "string" ||
      (!candidateKey.startsWith("copilot:") && candidateKey !== currentRunUserKey)
    ) {
      return false;
    }
  }
  // The embedded-runner boundary stamps the active user with this recorder
  // timestamp, so historical turns with the same content remain ineligible.
  return (
    candidate.timestamp === expected.timestamp &&
    projectUserContentIdentity(candidate.content) === projectUserContentIdentity(expected.content)
  );
}

export function projectUserContentIdentity(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content) && content.length === 1) {
    // SAFETY: The array guard establishes the single unknown content part read below.
    const part = content[0] as { text?: unknown; type?: unknown };
    if (part?.type === "text" && typeof part.text === "string") {
      return part.text;
    }
  }
  return JSON.stringify(content) ?? "";
}

export function isCompatibleSingletonRewrite(
  original: AttemptTranscriptMessage,
  prepared: AttemptTranscriptMessage,
): boolean {
  // Hooks may redact content, but role and tool topology are journal-owned;
  // accepting either rewrite would make the canonical replay structurally false.
  return (
    original.role === prepared.role &&
    (original.role !== "assistant" ||
      JSON.stringify(readAssistantToolCallIds(original)) ===
        JSON.stringify(readAssistantToolCallIds(prepared)))
  );
}

export function projectReplayPayload(message: AttemptTranscriptMessage): unknown {
  switch (message.role) {
    case "user":
      return { role: message.role, content: message.content };
    case "assistant":
      return {
        role: message.role,
        content: message.content,
        api: message.api,
        model: message.model,
        provider: message.provider,
        stopReason: message.stopReason,
      };
    case "toolResult":
      return {
        role: message.role,
        content: message.content,
        isError: message.isError,
        toolCallId: message.toolCallId,
        toolName: message.toolName,
      };
  }
  return undefined;
}

export function isCompleteToolGroup(
  messages: AttemptTranscriptMessage[],
  order: string[],
): boolean {
  const [assistant, ...results] = messages;
  return (
    assistant?.role === "assistant" &&
    JSON.stringify(readAssistantToolCallIds(assistant)) === JSON.stringify(order) &&
    results.length === order.length &&
    results.every(
      (message, index) => message.role === "toolResult" && message.toolCallId === order[index],
    )
  );
}

import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { readNonBlankString } from "@openclaw/normalization-core/string-coerce";
import type { TranscriptDisplayPosition } from "../chat/transcript-display-position.js";
import {
  createCurrentUserProfileMessageProjector,
  projectChatDisplayMessage,
  projectChatDisplayMessagesWithState,
} from "./chat-display-projection.js";
import { resolveCurrentUserProfileDisplay } from "./current-user-profile-display.js";

export type SessionMessageProjectionState = {
  streamErrorFallbackPending: boolean;
  turnBoundaryPending: boolean;
};

/** Attach OpenClaw metadata to a transcript message without dropping existing metadata. */
export function attachOpenClawTranscriptMeta(
  message: unknown,
  meta: Record<string, unknown>,
): unknown {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return message;
  }
  const record = message as Record<string, unknown>;
  const existing =
    record["__openclaw"] &&
    typeof record["__openclaw"] === "object" &&
    !Array.isArray(record["__openclaw"])
      ? (record["__openclaw"] as Record<string, unknown>)
      : {};
  return {
    ...record,
    __openclaw: {
      ...existing,
      ...meta,
    },
  };
}

function readTranscriptMessageSenderIsOwner(message: unknown): boolean | undefined {
  const openclaw = asOptionalRecord(asOptionalRecord(message)?.["__openclaw"]);
  const value = openclaw?.senderIsOwner;
  return typeof value === "boolean" ? value : undefined;
}

/** Project one transcript message into the exact payload emitted as session.message. */
export function projectSessionMessagePayload(params: {
  agentId?: string;
  message: unknown;
  messageId?: string;
  messageSeq?: number;
  transcriptPosition?: TranscriptDisplayPosition;
  projectionState?: SessionMessageProjectionState;
  projectCurrentUserProfile?: (message: Record<string, unknown>) => Record<string, unknown>;
  runId?: string;
  sessionKey: string;
  sessionSnapshot?: Record<string, unknown>;
}): { payload?: Record<string, unknown>; projectionState: SessionMessageProjectionState } {
  const idempotencyKey = readNonBlankString(asOptionalRecord(params.message)?.idempotencyKey);
  const senderIsOwner = readTranscriptMessageSenderIsOwner(params.message);
  const rawMessage = attachOpenClawTranscriptMeta(params.message, {
    // Placement comes from the selected reader snapshot, never persisted/imported metadata.
    transcriptPosition: params.transcriptPosition,
    ...(params.messageId ? { id: params.messageId } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
    ...(params.messageSeq !== undefined ? { seq: params.messageSeq } : {}),
  });
  const projected = params.projectionState
    ? projectChatDisplayMessagesWithState([rawMessage], {
        streamErrorFallbackPending: params.projectionState.streamErrorFallbackPending,
        turnBoundaryPending: params.projectionState.turnBoundaryPending,
      })
    : {
        messages: [projectChatDisplayMessage(rawMessage)],
        streamErrorFallbackPending: false,
        turnBoundaryPending: false,
      };
  const projectionState = {
    streamErrorFallbackPending: projected.streamErrorFallbackPending,
    turnBoundaryPending: projected.turnBoundaryPending,
  };
  const message = projected.messages[0];
  if (!message) {
    return { projectionState };
  }
  const projectCurrentUserProfile =
    params.projectCurrentUserProfile ??
    createCurrentUserProfileMessageProjector(resolveCurrentUserProfileDisplay);
  return {
    payload: {
      sessionKey: params.sessionKey,
      ...(senderIsOwner === undefined ? {} : { senderIsOwner }),
      ...(params.agentId ? { agentId: params.agentId } : {}),
      message: projectCurrentUserProfile(message),
      ...(params.messageId ? { messageId: params.messageId } : {}),
      ...(params.messageSeq !== undefined ? { messageSeq: params.messageSeq } : {}),
      ...params.sessionSnapshot,
      ...(params.runId ? { runId: params.runId } : {}),
    },
    projectionState,
  };
}

/** Project one stored transcript entry onto the client-visible chat history shape. */
export function projectTranscriptEntryMessage(
  entry: unknown,
  seq: number,
  transcriptPosition?: TranscriptDisplayPosition,
): unknown {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return null;
  }
  const record = entry as Record<string, unknown>;
  if (record.message) {
    const recordTimestampMs =
      typeof record.timestamp === "string"
        ? Date.parse(record.timestamp)
        : typeof record.timestamp === "number"
          ? record.timestamp
          : Number.NaN;
    const idempotencyKey = readNonBlankString(asOptionalRecord(record.message)?.idempotencyKey);
    return attachOpenClawTranscriptMeta(record.message, {
      ...(typeof record.id === "string" ? { id: record.id } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
      ...(Number.isFinite(recordTimestampMs) ? { recordTimestampMs } : {}),
      transcriptPosition,
      seq,
    });
  }
  if (record.type !== "compaction" && record.type !== "reset") {
    return null;
  }
  const kind = record.type;
  const parsedTimestamp =
    typeof record.timestamp === "string" ? Date.parse(record.timestamp) : Number.NaN;
  return {
    role: "system",
    content: [{ type: "text", text: kind === "compaction" ? "Compaction" : "Reset" }],
    timestamp: Number.isFinite(parsedTimestamp) ? parsedTimestamp : Date.now(),
    __openclaw: {
      kind,
      id: typeof record.id === "string" ? record.id : undefined,
      transcriptPosition,
      seq,
    },
  };
}

import type { MediaUnderstandingCapability } from "./types.js";

// Shared API contract id for OpenAI-compatible /audio/transcriptions requests.
export const OPENAI_AUDIO_TRANSCRIPTIONS_API = "openai-audio-transcriptions";

// Shipped transcribeAudio descriptors receive host-resolved API-key auth.
// Provider-prepared audio owns its credential contract and does not use this path.
export function resolveOpenAiAudioAuthModelApi(params: {
  capability: MediaUnderstandingCapability;
  providerId: string;
}): string | undefined {
  return params.capability === "audio" && params.providerId.trim().toLowerCase() === "openai"
    ? OPENAI_AUDIO_TRANSCRIPTIONS_API
    : undefined;
}

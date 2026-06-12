import type { BaseMessage } from "@langchain/core/messages";

/**
 * Shared graph state shape used by both `StreamProvider` and client hooks.
 *
 * The backend stores all model messages in the standard `messages` channel and
 * writes finalized storyteller output into `paragraphs` once the story page
 * split is known.
 */
export interface StoryState {
  messages: BaseMessage[];
  paragraphs?: string[];
}

/**
 * Minimal playback surface registered by `PageAudio` for provider-level
 * orchestration.
 */
export interface PagePlaybackHandle {
  play: () => Promise<void>;
  pause: () => void;
}

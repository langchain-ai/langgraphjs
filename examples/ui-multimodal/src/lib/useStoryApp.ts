import { createContext, useContext } from "react";
import type { PagePlaybackHandle } from "./types";

interface StoryAppContextValue {
  /** Whether the user has submitted a prompt and the story UI should render. */
  started: boolean;
  /** Switches the experience from the prompt form into the story view. */
  startStory: () => void;
  /** True while all page narrations should be played in order. */
  chainPlayEnabled: boolean;
  /** Starts or stops sequential narration playback. */
  toggleChainPlay: () => void;
  /** Registers the playback controls exposed by each `PageAudio` component. */
  setPageRef: (index: number, ref: PagePlaybackHandle | null) => void;
  /** Stops active work/playback and asks `App` to remount the stream. */
  resetStory: () => void;
}

export const StoryAppContext = createContext<StoryAppContextValue | null>(
  null
);

/**
 * Reads app-level UI state for the story demo.
 *
 * Components use this for concerns that are outside the graph state itself:
 * whether the prompt has been submitted, whether chain-play is active, and how
 * to reset the current stream.
 */
export function useStoryApp() {
  const value = useContext(StoryAppContext);
  if (value == null) {
    throw new Error("useStoryApp must be used within StoryAppProvider");
  }
  return value;
}

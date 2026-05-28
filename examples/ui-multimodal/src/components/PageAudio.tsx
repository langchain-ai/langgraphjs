import { useEffect } from "react";
import {
  useAudio,
  useAudioPlayer,
  useStreamContext,
} from "@langchain/react";

import { useNodeRun } from "../lib/useNodeRun";
import type { StoryState } from "../lib/types";
import { useStoryApp } from "../lib/useStoryApp";

/**
 * Renders and controls the narration clip for one page.
 *
 * The audio itself comes from the page's `narrator_${index}` node namespace.
 * The component also registers a tiny playback handle with `StoryAppProvider`
 * so the header's "Read aloud" button can play page narrations sequentially
 * without coupling the provider to `@langchain/react`'s audio player object.
 */
export function PageAudio({ index }: { index: number }) {
  const stream = useStreamContext<StoryState>();
  const { setPageRef } = useStoryApp();
  const narrator = useNodeRun(`narrator_${index}`);
  const audio = useAudio(stream, narrator?.namespace);
  const clip = audio[0];
  const player = useAudioPlayer(clip);
  const isPlaying = player.status === "playing";
  const audioReady = clip != null && player.status !== "error";

  const audioFailed =
    narrator?.status === "error" ||
    clip?.error != null ||
    player.status === "error";

  const audioStatusText = audioFailed
    ? "🔇 audio unavailable"
    : audioReady
      ? narrator?.status === "running"
        ? "streaming…"
        : "ready"
      : "listening…";

  useEffect(() => {
    // Register the latest player methods after render. This avoids passing refs
    // through PageCard while still giving chain-play a stable control surface.
    setPageRef(index, {
      play: () => player.playToEnd(),
      pause: () => player.pause(),
    });
    return () => setPageRef(index, null);
  }, [index, player, setPageRef]);

  return (
    <div className="page-card__audio">
      <button
        type="button"
        className={`audio-btn${audioReady && !isPlaying ? " audio-btn--pending" : ""
          }`}
        onClick={() => player.toggle()}
        disabled={!audioReady}
        aria-label={isPlaying ? "Pause narration" : "Play narration"}
      >
        {isPlaying ? "❚❚" : "▶"}
      </button>
      <div className="audio-meta">
        <span>Page {index + 1}</span>
        <span
          className={`audio-meta__status${audioFailed ? " audio-meta__status--error" : ""
            }`}
        >
          {audioStatusText}
        </span>
      </div>
    </div>
  );
}

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import {
  useAudio,
  useImages,
  useMediaURL,
  useProgressiveAudio,
  type SubgraphDiscoverySnapshot,
} from "@langchain/react";
import { PlaceholderImage } from "./PlaceholderImage";
import type { StreamHandle } from "../lib/types";

export interface PageCardHandle {
  /** Play the narration for this page, resolving on `ended`, rejecting on error. */
  play: () => Promise<void>;
  pause: () => void;
}

export interface PageCardProps {
  index: number;
  text: string;
  stream: StreamHandle;
  visualizerSubgraph: SubgraphDiscoverySnapshot | undefined;
  narratorSubgraph: SubgraphDiscoverySnapshot | undefined;
  onPlayRequestedPage?: (index: number) => void;
}

export const PageCard = forwardRef<PageCardHandle, PageCardProps>(
  function PageCard(props, ref) {
    const {
      index,
      text,
      stream,
      visualizerSubgraph,
      narratorSubgraph,
    } = props;

    const images = useImages(stream, visualizerSubgraph);
    const audio = useAudio(stream, narratorSubgraph);

    const image = images[0];
    const clip = audio[0];

    const imageURL = useMediaURL(image);
    const progressiveAudio = useProgressiveAudio(clip);

    const imageFailed =
      visualizerSubgraph?.status === "error" || image?.error != null;
    const audioFailed =
      narratorSubgraph?.status === "error" ||
      clip?.error != null ||
      progressiveAudio.error != null;

    // Chain-play orchestration: `play()` must resolve only when the
    // narration has actually finished playing. Capture the pending
    // resolver in a ref and let the effect below complete it as soon
    // as the hook reports a terminal state. Resolving synchronously
    // would cause the caller to start every page's audio in the same
    // tick — three narrators talking over each other.
    const pendingResolveRef = useRef<(() => void) | null>(null);
    const waitingForPlaybackRef = useRef(false);

    useEffect(() => {
      if (!waitingForPlaybackRef.current) return;
      // The hook flips `isPlaying` back to false only after the last
      // scheduled audio source has ended AND the upstream stream has
      // signalled finish. That's the earliest moment a follow-up page
      // can safely start without overlap.
      if (progressiveAudio.isFinished && !progressiveAudio.isPlaying) {
        waitingForPlaybackRef.current = false;
        const resolve = pendingResolveRef.current;
        pendingResolveRef.current = null;
        resolve?.();
      }
    }, [progressiveAudio.isPlaying, progressiveAudio.isFinished]);

    useImperativeHandle(
      ref,
      () => ({
        play: () =>
          new Promise<void>((resolve) => {
            // If a previous play() is still pending, replace its
            // resolver with the new one; the older caller would have
            // seen a resolve on the next terminal transition anyway.
            pendingResolveRef.current?.();
            pendingResolveRef.current = resolve;
            waitingForPlaybackRef.current = true;
            progressiveAudio.play();
          }),
        pause: () => {
          waitingForPlaybackRef.current = false;
          const resolve = pendingResolveRef.current;
          pendingResolveRef.current = null;
          progressiveAudio.pause();
          resolve?.();
        },
      }),
      [progressiveAudio]
    );

    const togglePlay = () => {
      if (progressiveAudio.isPlaying) {
        progressiveAudio.pause();
      } else {
        progressiveAudio.play();
      }
    };

    const imageReady = imageURL != null;
    // Audio is "ready" the instant a stream is open; progressive playback
    // begins as soon as the first chunk lands.
    const audioReady = clip != null && progressiveAudio.error == null;
    const isPlaying = progressiveAudio.isPlaying;

    return (
      <article className="page-card" aria-label={`Page ${index + 1}`}>
        <div
          className={`page-card__image-wrap${imageReady || imageFailed ? " page-card__image-wrap--ready" : ""}`}
        >
          {imageReady ? (
            <img
              className="page-card__image"
              src={imageURL}
              alt={`Illustration for page ${index + 1}`}
            />
          ) : imageFailed ? (
            <PlaceholderImage muted />
          ) : null}
        </div>

        <p
          className={`page-card__text${text.length === 0 ? " page-card__text--empty" : ""}`}
        >
          {text.length > 0 ? text : "quietly gathering the words…"}
          {narratorSubgraph?.status !== "complete" && text.length > 0 ? (
            <span className="page-card__text-caret" />
          ) : null}
        </p>

        <div className="page-card__audio">
          <button
            type="button"
            className={`audio-btn${
              audioReady && !isPlaying ? " audio-btn--pending" : ""
            }`}
            onClick={togglePlay}
            disabled={!audioReady}
            aria-label={isPlaying ? "Pause narration" : "Play narration"}
          >
            {isPlaying ? "❚❚" : "▶"}
          </button>
          <div className="audio-meta">
            <span>Page {index + 1}</span>
            <span
              className={`audio-meta__status${
                audioFailed ? " audio-meta__status--error" : ""
              }`}
            >
              {audioFailed
                ? "🔇 audio unavailable"
                : audioReady
                  ? progressiveAudio.isFinished
                    ? "ready"
                    : "streaming…"
                  : "listening…"}
            </span>
          </div>
        </div>
      </article>
    );
  }
);

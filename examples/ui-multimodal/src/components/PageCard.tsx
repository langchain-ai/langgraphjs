import { forwardRef, useImperativeHandle, useRef } from "react";
import {
  useAudio,
  useAudioPlayer,
  useImages,
  useMediaURL,
  useVideo,
  useVideoPlayer,
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
  /**
   * Illustration modality for this page. `"image"` pages draw from a
   * `visualizer_*` subgraph; `"video"` pages from a `videographer_*`
   * subgraph (e.g. Sora 2).
   *
   * This is passed explicitly — rather than inferred from which subgraph
   * prop is set — because the corresponding subgraph snapshot is
   * `undefined` until the node actually starts. Without the explicit
   * variant, a video page would temporarily fall into image-mode and
   * show whatever root-scoped image arrived first.
   */
  variant: "image" | "video";
  /** Set when the page's illustration is a Responses-API generated image. */
  visualizerSubgraph?: SubgraphDiscoverySnapshot | undefined;
  /** Set when the page's illustration is a Sora-generated video. */
  videographerSubgraph?: SubgraphDiscoverySnapshot | undefined;
  narratorSubgraph: SubgraphDiscoverySnapshot | undefined;
  onPlayRequestedPage?: (index: number) => void;
}

export const PageCard = forwardRef<PageCardHandle, PageCardProps>(
  function PageCard(props, ref) {
    const {
      index,
      text,
      stream,
      variant,
      visualizerSubgraph,
      videographerSubgraph,
      narratorSubgraph,
    } = props;

    const isVideoPage = variant === "video";

    // Subscribe to both modalities unconditionally (hooks rules), but
    // only USE the one this page is wired for. `useImages(stream,
    // undefined)` returns root-scoped images from every visualizer —
    // so on a video page we must ignore `images[0]` entirely, otherwise
    // the Sora slot would borrow whatever illustration arrived first
    // (e.g. page 0's) while the render is still in flight.
    const images = useImages(stream, visualizerSubgraph);
    const videos = useVideo(stream, videographerSubgraph);
    const audio = useAudio(stream, narratorSubgraph);

    const image = isVideoPage ? undefined : images[0];
    const video = isVideoPage ? videos[0] : undefined;
    const clip = audio[0];

    const imageURL = useMediaURL(image);
    const videoRef = useRef<HTMLVideoElement | null>(null);
    // The Sora clip is ambient wallpaper for the page — autoplay as
    // soon as the blob URL is minted, loop forever, and don't tie it
    // to narration. The native `loop` attribute on <video> keeps the
    // element in "playing" indefinitely (no `ended` fires), which is
    // fine for this hook because we never call `playToEnd()` on it.
    const videoPlayer = useVideoPlayer(videoRef, video, { autoPlay: true });
    const player = useAudioPlayer(clip);

    const imageFailed =
      visualizerSubgraph?.status === "error" || image?.error != null;
    const videoFailed =
      videographerSubgraph?.status === "error" ||
      video?.error != null ||
      videoPlayer.status === "error";
    const audioFailed =
      narratorSubgraph?.status === "error" ||
      clip?.error != null ||
      player.status === "error";

    useImperativeHandle(
      ref,
      () => ({
        // `playToEnd` resolves on the next terminal transition
        // (`finished` / `paused` / `idle`), rejects on `error`. That's
        // exactly the "done narrating, safe to advance" signal the
        // chain-play orchestrator needs. The Sora clip loops
        // independently — no need to gate it on narration.
        play: () => player.playToEnd(),
        pause: () => player.pause(),
      }),
      [player]
    );

    const isPlaying = player.status === "playing";
    const isStreaming =
      player.status === "buffering" || player.status === "playing";

    const imageReady = imageURL != null;
    const videoReady = video != null && videoPlayer.status !== "error";
    const audioReady = clip != null && player.status !== "error";

    return (
      <article className="page-card" aria-label={`Page ${index + 1}`}>
        <div
          className={`page-card__image-wrap${
            (isVideoPage ? videoReady || videoFailed : imageReady || imageFailed)
              ? " page-card__image-wrap--ready"
              : ""
          }`}
        >
          {isVideoPage ? (
            // Always render the element so `useVideoPlayer` can bind on
            // the first frame we receive. Hide it until the blob URL is
            // wired so the poster area stays clean during buffering.
            //
            // `loop` makes the Sora clip run as ambient wallpaper, and
            // `muted` + `playsInline` bypass mobile-browser autoplay
            // guardrails so `autoPlay: true` on the hook actually takes
            // effect without a user gesture.
            <video
              ref={videoRef}
              className="page-card__image"
              playsInline
              muted
              loop
              style={{
                display: videoReady && !videoFailed ? undefined : "none",
              }}
            />
          ) : imageReady ? (
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
            onClick={() => player.toggle()}
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
                  ? player.status === "finished"
                    ? "ready"
                    : isStreaming
                      ? "streaming…"
                      : "ready"
                  : "listening…"}
            </span>
          </div>
        </div>
      </article>
    );
  }
);

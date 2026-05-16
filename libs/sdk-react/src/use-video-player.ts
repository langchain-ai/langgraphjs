/* __LC_ALLOW_ENTRYPOINT_SIDE_EFFECTS__ */

"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { VideoMedia } from "@langchain/langgraph-sdk/stream";
import type { PlayerStatus } from "./use-audio-player.js";

/**
 * Options for {@link useVideoPlayer}.
 */
export interface UseVideoPlayerOptions {
  /**
   * Start playback as soon as the blob URL resolves. Subject to
   * browser autoplay policies — pair with `muted={true}` on the
   * `<video>` element to bypass the user-gesture requirement.
   */
  autoPlay?: boolean;
}

/**
 * Controls + live state returned by {@link useVideoPlayer}. Mirrors
 * {@link AudioPlayerHandle} on the shared subset so callers only ever
 * learn one shape.
 */
export interface VideoPlayerHandle {
  status: PlayerStatus;
  play(): void;
  pause(): void;
  stop(): void;
  toggle(): void;
  reset(): void;
  /**
   * Resolve on the next terminal transition (`finished` / `paused` /
   * `idle`). Reject on transitions to `"error"`. Triggers `play()`
   * when called.
   */
  playToEnd(): Promise<void>;

  currentTime: number;
  /** Total duration (seconds) once the element has parsed the blob. */
  duration?: number;
  /** Seek to an absolute timestamp in seconds. */
  seek(seconds: number): void;

  error: Error | undefined;
}

/**
 * Bind a {@link VideoMedia} handle to a caller-owned `<video>` element.
 *
 * ### Contract
 *
 * - The caller renders `<video ref={videoRef}>` and styles it however
 *   they like; the hook never injects DOM nor overrides layout.
 * - On `message-finish`, the underlying blob URL is minted and assigned
 *   as `video.src`. Progressive playback of streamed container video
 *   (fragmented mp4 / webm via MSE) is out of scope for this version;
 *   `status` stays in `"buffering"` until the blob resolves.
 * - Element events (`play` / `pause` / `ended` / `timeupdate` /
 *   `loadedmetadata` / `error`) are translated into the shared
 *   {@link PlayerStatus} enum.
 * - On unmount, `media.revoke()` is called to free the object URL.
 *
 * @param videoRef - Ref to the `<video>` element the caller renders.
 * @param media    - Video handle from {@link useVideo}.
 * @param options  - Auto-play toggle.
 */
export function useVideoPlayer(
  videoRef: RefObject<HTMLVideoElement | null>,
  media: VideoMedia | undefined,
  options?: UseVideoPlayerOptions
): VideoPlayerHandle {
  const autoPlay = options?.autoPlay ?? false;

  const [status, setStatus] = useState<PlayerStatus>("idle");
  const [error, setError] = useState<Error | undefined>(undefined);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState<number | undefined>(undefined);

  const statusRef = useRef<PlayerStatus>("idle");
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  const shouldPlayRef = useRef(false);
  const pendingResolveRef = useRef<(() => void) | null>(null);
  const pendingRejectRef = useRef<((err: Error) => void) | null>(null);

  const resolvePending = useCallback(() => {
    const resolve = pendingResolveRef.current;
    pendingResolveRef.current = null;
    pendingRejectRef.current = null;
    resolve?.();
  }, []);

  const rejectPending = useCallback((err: Error) => {
    const reject = pendingRejectRef.current;
    pendingResolveRef.current = null;
    pendingRejectRef.current = null;
    reject?.(err);
  }, []);

  useEffect(() => {
    if (status === "finished" || status === "paused" || status === "idle") {
      resolvePending();
    } else if (status === "error") {
      rejectPending(error ?? new Error("playback error"));
    }
  }, [status, error, resolvePending, rejectPending]);

  const play = useCallback(() => {
    if (media == null) return;
    if (statusRef.current === "error") return;
    shouldPlayRef.current = true;
    const video = videoRef.current;
    if (video == null) {
      setStatus("buffering");
      return;
    }
    video.play().catch((err) => {
      setError(err as Error);
      setStatus("error");
    });
  }, [media, videoRef]);

  const pause = useCallback(() => {
    shouldPlayRef.current = false;
    videoRef.current?.pause();
    if (statusRef.current === "playing" || statusRef.current === "buffering") {
      setStatus("paused");
    }
  }, [videoRef]);

  const stop = useCallback(() => {
    shouldPlayRef.current = false;
    const video = videoRef.current;
    if (video != null) {
      video.pause();
      video.currentTime = 0;
    }
    setCurrentTime(0);
    setStatus(media == null ? "idle" : "paused");
  }, [videoRef, media]);

  const reset = useCallback(() => {
    stop();
    setError(undefined);
    setDuration(undefined);
    setStatus("idle");
  }, [stop]);

  const toggle = useCallback(() => {
    if (statusRef.current === "playing") pause();
    else play();
  }, [play, pause]);

  const playToEnd = useCallback((): Promise<void> => {
    pendingResolveRef.current?.();
    pendingResolveRef.current = null;
    pendingRejectRef.current = null;

    return new Promise<void>((resolve, reject) => {
      pendingResolveRef.current = resolve;
      pendingRejectRef.current = reject;
      play();
    });
  }, [play]);

  const seek = useCallback(
    (seconds: number) => {
      const video = videoRef.current;
      if (video == null) return;
      video.currentTime = seconds;
      setCurrentTime(seconds);
    },
    [videoRef]
  );

  // Surface a media-level error immediately.
  useEffect(() => {
    if (media?.error == null) return;
    setError(new Error(media.error.message));
    setStatus("error");
  }, [media]);

  // Bind the element to the blob URL once it resolves.
  useEffect(() => {
    if (media == null) {
      setStatus("idle");
      setError(undefined);
      setCurrentTime(0);
      setDuration(undefined);
      return undefined;
    }

    setError(undefined);
    setStatus("buffering");
    setCurrentTime(0);
    setDuration(undefined);

    let cancelled = false;
    const video = videoRef.current;

    media.objectURL.then(
      (resolved) => {
        if (cancelled) return;
        if (video == null) return;
        video.src = resolved;

        if (shouldPlayRef.current || autoPlay) {
          video.play().catch((err) => {
            setError(err as Error);
            setStatus("error");
          });
        } else {
          setStatus("paused");
        }
      },
      () => {
        if (!cancelled) {
          setError(new Error("media failed to materialise"));
          setStatus("error");
        }
      }
    );

    if (video == null) {
      return () => {
        cancelled = true;
        try {
          media.revoke();
        } catch {
          // best-effort
        }
      };
    }

    const onPlay = () => {
      if (statusRef.current !== "error") setStatus("playing");
    };
    const onPause = () => {
      if (video.ended) return;
      if (statusRef.current === "playing") setStatus("paused");
    };
    const onEnded = () => {
      setStatus("finished");
    };
    const onTimeUpdate = () => {
      setCurrentTime(video.currentTime);
    };
    const onLoadedMetadata = () => {
      if (Number.isFinite(video.duration)) setDuration(video.duration);
    };
    const onError = () => {
      setError(new Error("HTMLVideoElement error"));
      setStatus("error");
    };

    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("ended", onEnded);
    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("loadedmetadata", onLoadedMetadata);
    video.addEventListener("error", onError);

    return () => {
      cancelled = true;
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("ended", onEnded);
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("loadedmetadata", onLoadedMetadata);
      video.removeEventListener("error", onError);
      try {
        video.pause();
        video.removeAttribute("src");
        video.load();
      } catch {
        // best-effort
      }
      try {
        media.revoke();
      } catch {
        // best-effort
      }
    };
  }, [media, videoRef, autoPlay]);

  return {
    status,
    play,
    pause,
    stop,
    toggle,
    reset,
    playToEnd,
    currentTime,
    duration,
    seek,
    error,
  };
}

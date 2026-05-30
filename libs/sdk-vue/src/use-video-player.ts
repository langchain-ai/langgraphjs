import {
  ref,
  watch,
  onScopeDispose,
  toValue,
  type MaybeRefOrGetter,
  type Ref,
} from "vue";
import type { VideoMedia } from "@langchain/langgraph-sdk/stream";
import type { PlayerStatus } from "./use-audio-player.js";

/** Options for {@link useVideoPlayer}. */
export interface UseVideoPlayerOptions {
  /**
   * Start playback as soon as the blob URL resolves. Subject to
   * browser autoplay policies — pair with `<video muted>` to bypass
   * the user-gesture requirement.
   */
  autoPlay?: boolean;
}

/**
 * Controls + live state returned by {@link useVideoPlayer}. Mirrors
 * {@link AudioPlayerHandle} on the shared subset so callers only ever
 * learn one shape.
 */
export interface VideoPlayerHandle {
  readonly status: Readonly<Ref<PlayerStatus>>;
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

  readonly currentTime: Readonly<Ref<number>>;
  /** Total duration (seconds) once the element has parsed the blob. */
  readonly duration: Readonly<Ref<number | undefined>>;
  seek(seconds: number): void;

  readonly error: Readonly<Ref<Error | undefined>>;
}

/**
 * Bind a {@link VideoMedia} handle to a caller-owned `<video>` element.
 *
 * Vue idioms:
 *  - `videoRef` accepts a raw `HTMLVideoElement`, a `Ref<...>`, or a
 *    getter. Pair with `<video ref="video" />` in the template, then
 *    pass the template ref straight in.
 *  - The composable never injects DOM nor overrides layout.
 *  - On scope disposal (or when `media` changes) the composable calls
 *    `media.revoke()` to free the object URL.
 *
 * @param videoRef - Reactive reference to the `<video>` element.
 * @param media    - Video handle from {@link useVideo}.
 * @param options  - Auto-play toggle.
 */
export function useVideoPlayer(
  videoRef: MaybeRefOrGetter<HTMLVideoElement | null | undefined>,
  media: MaybeRefOrGetter<VideoMedia | undefined>,
  options?: UseVideoPlayerOptions
): VideoPlayerHandle {
  const autoPlay = options?.autoPlay ?? false;

  const status = ref<PlayerStatus>("idle");
  const error = ref<Error | undefined>(undefined);
  const currentTime = ref(0);
  const duration = ref<number | undefined>(undefined);

  let shouldPlay = false;
  let pendingResolve: (() => void) | null = null;
  let pendingReject: ((err: Error) => void) | null = null;

  const resolvePending = () => {
    const r = pendingResolve;
    pendingResolve = null;
    pendingReject = null;
    r?.();
  };
  const rejectPending = (err: Error) => {
    const r = pendingReject;
    pendingResolve = null;
    pendingReject = null;
    r?.(err);
  };

  watch(
    () => status.value,
    (s) => {
      if (s === "finished" || s === "paused" || s === "idle") {
        resolvePending();
      } else if (s === "error") {
        rejectPending(error.value ?? new Error("playback error"));
      }
    }
  );

  const getVideo = () => toValue(videoRef) ?? null;

  const play = () => {
    const m = toValue(media);
    if (m == null) return;
    if (status.value === "error") return;
    shouldPlay = true;
    const video = getVideo();
    if (video == null) {
      status.value = "buffering";
      return;
    }
    video.play().catch((err) => {
      error.value = err as Error;
      status.value = "error";
    });
  };

  const pause = () => {
    shouldPlay = false;
    getVideo()?.pause();
    if (status.value === "playing" || status.value === "buffering") {
      status.value = "paused";
    }
  };

  const stop = () => {
    shouldPlay = false;
    const video = getVideo();
    if (video != null) {
      video.pause();
      video.currentTime = 0;
    }
    currentTime.value = 0;
    status.value = toValue(media) == null ? "idle" : "paused";
  };

  const reset = () => {
    stop();
    error.value = undefined;
    duration.value = undefined;
    status.value = "idle";
  };

  const toggle = () => {
    if (status.value === "playing") pause();
    else play();
  };

  const playToEnd = (): Promise<void> => {
    pendingResolve?.();
    pendingResolve = null;
    pendingReject = null;
    return new Promise<void>((resolve, reject) => {
      pendingResolve = resolve;
      pendingReject = reject;
      play();
    });
  };

  const seek = (seconds: number) => {
    const video = getVideo();
    if (video == null) return;
    video.currentTime = seconds;
    currentTime.value = seconds;
  };

  // Teardown callbacks registered when we bind a media instance.
  let detach: (() => void) | null = null;

  const bind = (m: VideoMedia, video: HTMLVideoElement | null) => {
    error.value = undefined;
    status.value = "buffering";
    currentTime.value = 0;
    duration.value = undefined;

    let cancelled = false;

    m.objectURL.then(
      (resolved) => {
        if (cancelled) return;
        if (video == null) return;
        video.src = resolved;

        if (shouldPlay || autoPlay) {
          video.play().catch((err) => {
            error.value = err as Error;
            status.value = "error";
          });
        } else {
          status.value = "paused";
        }
      },
      () => {
        if (!cancelled) {
          error.value = new Error("media failed to materialise");
          status.value = "error";
        }
      }
    );

    if (video == null) {
      return () => {
        cancelled = true;
        try {
          m.revoke();
        } catch {
          // best-effort
        }
      };
    }

    const onPlay = () => {
      if (status.value !== "error") status.value = "playing";
    };
    const onPause = () => {
      if (video.ended) return;
      if (status.value === "playing") status.value = "paused";
    };
    const onEnded = () => {
      status.value = "finished";
    };
    const onTimeUpdate = () => {
      currentTime.value = video.currentTime;
    };
    const onLoadedMetadata = () => {
      if (Number.isFinite(video.duration)) duration.value = video.duration;
    };
    const onError = () => {
      error.value = new Error("HTMLVideoElement error");
      status.value = "error";
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
        m.revoke();
      } catch {
        // best-effort
      }
    };
  };

  // Surface a media-level error immediately and (re)bind on change.
  watch(
    () => [toValue(media), toValue(videoRef)] as const,
    ([m, video]) => {
      detach?.();
      detach = null;

      if (m == null) {
        status.value = "idle";
        error.value = undefined;
        currentTime.value = 0;
        duration.value = undefined;
        return;
      }

      if (m.error != null) {
        error.value = new Error(m.error.message);
        status.value = "error";
        return;
      }

      detach = bind(m, video ?? null);
    },
    { immediate: true, flush: "post" }
  );

  onScopeDispose(() => {
    detach?.();
    detach = null;
  });

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

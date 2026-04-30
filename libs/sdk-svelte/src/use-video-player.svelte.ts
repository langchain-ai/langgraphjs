import { onDestroy } from "svelte";
import type { VideoMedia } from "@langchain/langgraph-sdk/stream";
import type { ValueOrGetter } from "./use-projection.svelte.js";
import type { PlayerStatus } from "./use-audio-player.svelte.js";

function unwrap<T>(input: ValueOrGetter<T>): T {
  if (typeof input === "function") return (input as () => T)();
  return input;
}

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
 * `AudioPlayerHandle` on the shared subset so callers only ever
 * learn one shape.
 */
export interface VideoPlayerHandle {
  readonly status: PlayerStatus;
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

  readonly currentTime: number;
  /** Total duration (seconds) once the element has parsed the blob. */
  readonly duration: number | undefined;
  seek(seconds: number): void;

  readonly error: Error | undefined;
}

/**
 * Bind a {@link VideoMedia} handle to a caller-owned `<video>`
 * element.
 *
 * Svelte idioms:
 *  - `videoRef` accepts a raw `HTMLVideoElement`, a `$state` binding,
 *    or a getter. Use Svelte 5's `bind:this` to assign a template
 *    reference and pass it via a getter so the composable re-binds
 *    when the element first mounts:
 *    ```svelte
 *    <script lang="ts">
 *      let videoEl = $state<HTMLVideoElement>();
 *      const player = useVideoPlayer(() => videoEl, () => media);
 *    </script>
 *    <video bind:this={videoEl} />
 *    ```
 *  - The composable never injects DOM nor overrides layout.
 *  - On component destroy (or when `media` changes) the composable
 *    calls `media.revoke()` to free the object URL.
 *
 * @param videoRef - Reactive reference to the `<video>` element.
 * @param media    - Video handle from `useVideo`.
 * @param options  - Auto-play toggle.
 */
export function useVideoPlayer(
  videoRef: ValueOrGetter<HTMLVideoElement | null | undefined>,
  media: ValueOrGetter<VideoMedia | undefined>,
  options?: UseVideoPlayerOptions
): VideoPlayerHandle {
  const autoPlay = options?.autoPlay ?? false;

  let status = $state<PlayerStatus>("idle");
  let error = $state<Error | undefined>(undefined);
  let currentTime = $state(0);
  let duration = $state<number | undefined>(undefined);

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

  $effect(() => {
    const s = status;
    if (s === "finished" || s === "paused" || s === "idle") {
      resolvePending();
    } else if (s === "error") {
      rejectPending(error ?? new Error("playback error"));
    }
  });

  const getVideo = () => unwrap(videoRef) ?? null;

  const play = () => {
    const m = unwrap(media);
    if (m == null) return;
    if (status === "error") return;
    shouldPlay = true;
    const video = getVideo();
    if (video == null) {
      status = "buffering";
      return;
    }
    video.play().catch((err) => {
      error = err as Error;
      status = "error";
    });
  };

  const pause = () => {
    shouldPlay = false;
    getVideo()?.pause();
    if (status === "playing" || status === "buffering") {
      status = "paused";
    }
  };

  const stop = () => {
    shouldPlay = false;
    const video = getVideo();
    if (video != null) {
      video.pause();
      video.currentTime = 0;
    }
    currentTime = 0;
    status = unwrap(media) == null ? "idle" : "paused";
  };

  const reset = () => {
    stop();
    error = undefined;
    duration = undefined;
    status = "idle";
  };

  const toggle = () => {
    if (status === "playing") pause();
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
    currentTime = seconds;
  };

  let detach: (() => void) | null = null;

  const bind = (m: VideoMedia, video: HTMLVideoElement | null) => {
    error = undefined;
    status = "buffering";
    currentTime = 0;
    duration = undefined;

    let cancelled = false;

    m.objectURL.then(
      (resolved) => {
        if (cancelled) return;
        if (video == null) return;
        video.src = resolved;

        if (shouldPlay || autoPlay) {
          video.play().catch((err) => {
            error = err as Error;
            status = "error";
          });
        } else {
          status = "paused";
        }
      },
      () => {
        if (!cancelled) {
          error = new Error("media failed to materialise");
          status = "error";
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
      if (status !== "error") status = "playing";
    };
    const onPause = () => {
      if (video.ended) return;
      if (status === "playing") status = "paused";
    };
    const onEnded = () => {
      status = "finished";
    };
    const onTimeUpdate = () => {
      currentTime = video.currentTime;
    };
    const onLoadedMetadata = () => {
      if (Number.isFinite(video.duration)) duration = video.duration;
    };
    const onError = () => {
      error = new Error("HTMLVideoElement error");
      status = "error";
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

  $effect(() => {
    const m = unwrap(media);
    const video = unwrap(videoRef) ?? null;

    detach?.();
    detach = null;

    if (m == null) {
      status = "idle";
      error = undefined;
      currentTime = 0;
      duration = undefined;
      return;
    }

    if (m.error != null) {
      error = new Error(m.error.message);
      status = "error";
      return;
    }

    detach = bind(m, video);
  });

  onDestroy(() => {
    detach?.();
    detach = null;
  });

  return {
    get status() {
      return status;
    },
    play,
    pause,
    stop,
    toggle,
    reset,
    playToEnd,
    get currentTime() {
      return currentTime;
    },
    get duration() {
      return duration;
    },
    seek,
    get error() {
      return error;
    },
  };
}

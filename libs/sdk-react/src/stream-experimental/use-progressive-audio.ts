/* __LC_ALLOW_ENTRYPOINT_SIDE_EFFECTS__ */

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { MediaBase } from "@langchain/langgraph-sdk/stream";

/**
 * Options for {@link useProgressiveAudio}.
 *
 * All fields optional; sensible defaults cover OpenAI `gpt-4o-audio-preview`
 * pcm16 streams (`sampleRate: 24000`, `channels: 1`).
 */
export interface UseProgressiveAudioOptions {
  /**
   * Sample rate of incoming PCM audio, in Hz. Ignored for containerised
   * formats (e.g. wav / mp3). Defaults to `24000`.
   */
  sampleRate?: number;
  /** Channel count of incoming PCM audio. Defaults to `1` (mono). */
  channels?: number;
  /**
   * Additional `mime_type` prefixes that should be treated as raw PCM16
   * (in addition to `audio/pcm`). Useful if upstream reports a custom mime
   * like `audio/L16`.
   */
  pcmMimePrefixes?: readonly string[];
}

/**
 * Playback state returned by {@link useProgressiveAudio}.
 */
export interface ProgressiveAudioState {
  /**
   * Start (or resume) playback. If the underlying stream has not emitted
   * any bytes yet, playback begins as soon as the first chunk arrives.
   */
  play: () => void;
  /** Pause playback. Buffered samples stay queued for the next `play()`. */
  pause: () => void;
  /**
   * Stop playback, discard the scheduled queue and tear down the
   * `AudioContext`. Next `play()` starts fresh from the current buffered
   * samples.
   */
  stop: () => void;
  /** Whether audio is currently rendering to the output device. */
  isPlaying: boolean;
  /** `true` after the final `content-block-finish` event has landed. */
  isFinished: boolean;
  /** Last error raised by the stream reader or decoder, if any. */
  error: Error | undefined;
}

const DEFAULT_SAMPLE_RATE = 24_000;
const DEFAULT_CHANNELS = 1;

/**
 * Events fanned out from a shared {@link PumpController} to each hook
 * subscription.
 */
type PumpEvent =
  | { readonly type: "chunk"; readonly bytes: Uint8Array }
  | { readonly type: "finished" }
  | { readonly type: "error"; readonly error: Error };

type PumpListener = (event: PumpEvent) => void;

interface PumpController {
  readonly chunks: Uint8Array[];
  finished: boolean;
  error: Error | undefined;
  readonly listeners: Set<PumpListener>;
}

/**
 * Module-level registry of shared readers keyed by {@link MediaBase}
 * identity. We hold exactly one {@link ReadableStreamDefaultReader} per
 * media handle and fan the chunks out to every live hook subscriber.
 *
 * Keying on identity (WeakMap) gives us several properties for free:
 * - React StrictMode's simulated unmount/remount finds the same
 *   controller on re-attach, so we never `getReader()` twice on the
 *   same locked stream.
 * - New `MediaBase` instances emitted by the assembler (e.g. after a
 *   stream rotation) get a fresh reader — no cross-talk.
 * - When callers drop their last reference to the media handle, the
 *   WeakMap entry is reclaimed alongside it.
 */
const pumpRegistry = new WeakMap<MediaBase, PumpController>();

/**
 * Attach a listener to the shared pump for `media`. The pump is started
 * lazily on first subscription and then lives for the entire lifetime
 * of the media handle — we never cancel the reader, because other
 * hook instances (including StrictMode remounts) may still rely on the
 * buffered replay.
 *
 * @returns An `unsubscribe` function. Callers are expected to invoke it
 *   when their component unmounts; it only detaches the listener.
 */
function attachToPump(media: MediaBase, listener: PumpListener): () => void {
  let controller = pumpRegistry.get(media);
  if (controller == null) {
    const reader = media.stream.getReader();
    controller = {
      chunks: [],
      finished: false,
      error: undefined,
      listeners: new Set<PumpListener>(),
    };
    pumpRegistry.set(media, controller);
    const owned = controller;
    void (async () => {
      try {
        // oxlint-disable-next-line no-constant-condition
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value == null || value.byteLength === 0) continue;
          owned.chunks.push(value);
          for (const l of owned.listeners) {
            try {
              l({ type: "chunk", bytes: value });
            } catch {
              // A misbehaving listener must not take down the pump.
            }
          }
        }
        owned.finished = true;
        for (const l of owned.listeners) {
          try {
            l({ type: "finished" });
          } catch {
            // Swallow — see above.
          }
        }
      } catch (err) {
        owned.error = err as Error;
        for (const l of owned.listeners) {
          try {
            l({ type: "error", error: err as Error });
          } catch {
            // Swallow — see above.
          }
        }
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // best-effort
        }
      }
    })();
  }

  // Replay buffered state so late subscribers (StrictMode remount or
  // any downstream consumer that mounts after the stream has already
  // delivered bytes) catch up to the current position.
  for (const chunk of controller.chunks) {
    listener({ type: "chunk", bytes: chunk });
  }
  if (controller.finished) listener({ type: "finished" });
  if (controller.error != null) {
    listener({ type: "error", error: controller.error });
  }

  controller.listeners.add(listener);

  return () => {
    controller!.listeners.delete(listener);
  };
}

/**
 * Progressive audio playback for media handles that emit raw pcm16 (little
 * endian, signed 16-bit) chunks, such as OpenAI `gpt-4o-audio-preview` with
 * `format: "pcm16"`. Each chunk is decoded and scheduled on a single
 * `AudioContext` so playback starts within one chunk of the first byte
 * arriving — no need to wait for `message-finish`.
 *
 * ### Behaviour
 * - The hook subscribes to a shared reader per {@link MediaBase}
 *   identity. Multiple concurrent consumers (including React
 *   StrictMode remounts) all observe the same byte stream and receive
 *   a replay of previously buffered chunks on attach.
 * - Chunks accumulate even when paused; `play()` resumes from the
 *   current scheduled position.
 * - When `media.mimeType` is not a recognised PCM variant, the hook
 *   no-ops and emits `error` with a hint so callers can fall back to
 *   {@link useMediaURL}.
 * - Unmount and `media` change both call `stop()` and close the
 *   per-hook `AudioContext` to release the audio hardware.
 *
 * @param media - Media handle produced by `useAudio` etc.
 * @param options - Override PCM sample rate / channel count / mime prefixes.
 * @returns Playback controls and live state.
 */
export function useProgressiveAudio(
  media: MediaBase | undefined,
  options?: UseProgressiveAudioOptions
): ProgressiveAudioState {
  const sampleRate = options?.sampleRate ?? DEFAULT_SAMPLE_RATE;
  const channels = options?.channels ?? DEFAULT_CHANNELS;
  const pcmPrefixes = options?.pcmMimePrefixes;

  const [isPlaying, setIsPlaying] = useState(false);
  const [isFinished, setIsFinished] = useState(false);
  const [error, setError] = useState<Error | undefined>(undefined);

  const ctxRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const shouldPlayRef = useRef<boolean>(false);
  const pendingChunksRef = useRef<Uint8Array[]>([]);
  const activeSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());

  const ensureContext = useCallback((): AudioContext | null => {
    if (ctxRef.current != null) return ctxRef.current;
    const AudioCtx =
      typeof window === "undefined"
        ? undefined
        : ((window as unknown as { AudioContext?: typeof AudioContext })
            .AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext })
            .webkitAudioContext);
    if (AudioCtx == null) {
      setError(new Error("Web Audio API is not available in this environment"));
      return null;
    }
    const ctx = new AudioCtx({ sampleRate });
    ctxRef.current = ctx;
    nextStartTimeRef.current = ctx.currentTime;
    return ctx;
  }, [sampleRate]);

  const scheduleChunk = useCallback(
    (ctx: AudioContext, bytes: Uint8Array) => {
      const sampleCount = Math.floor(bytes.byteLength / 2);
      if (sampleCount === 0) return;
      const framesPerChannel = Math.floor(sampleCount / channels);
      if (framesPerChannel === 0) return;

      const buffer = ctx.createBuffer(channels, framesPerChannel, sampleRate);
      const view = new DataView(
        bytes.buffer,
        bytes.byteOffset,
        framesPerChannel * channels * 2
      );
      for (let channel = 0; channel < channels; channel += 1) {
        const channelData = buffer.getChannelData(channel);
        for (let frame = 0; frame < framesPerChannel; frame += 1) {
          const sampleOffset = (frame * channels + channel) * 2;
          const int = view.getInt16(sampleOffset, true);
          channelData[frame] = int < 0 ? int / 0x8000 : int / 0x7fff;
        }
      }

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      const now = ctx.currentTime;
      const startAt = Math.max(now, nextStartTimeRef.current);
      source.start(startAt);
      nextStartTimeRef.current = startAt + buffer.duration;
      activeSourcesRef.current.add(source);
      source.onended = () => {
        activeSourcesRef.current.delete(source);
        if (
          activeSourcesRef.current.size === 0 &&
          isFinishedRef.current &&
          pendingChunksRef.current.length === 0
        ) {
          setIsPlaying(false);
        }
      };
    },
    [channels, sampleRate]
  );

  const flushPending = useCallback(() => {
    const ctx = ctxRef.current;
    if (ctx == null) return;
    if (!shouldPlayRef.current) return;
    if (ctx.state === "suspended") void ctx.resume();
    const chunks = pendingChunksRef.current;
    pendingChunksRef.current = [];
    for (const bytes of chunks) scheduleChunk(ctx, bytes);
    if (chunks.length > 0) setIsPlaying(true);
  }, [scheduleChunk]);

  const isFinishedRef = useRef(false);
  useEffect(() => {
    isFinishedRef.current = isFinished;
  }, [isFinished]);

  const play = useCallback(() => {
    shouldPlayRef.current = true;
    const ctx = ensureContext();
    if (ctx == null) return;
    if (ctx.state === "suspended") void ctx.resume();
    flushPending();
    setIsPlaying(true);
  }, [ensureContext, flushPending]);

  const pause = useCallback(() => {
    shouldPlayRef.current = false;
    const ctx = ctxRef.current;
    if (ctx != null && ctx.state === "running") void ctx.suspend();
    setIsPlaying(false);
  }, []);

  const stop = useCallback(() => {
    shouldPlayRef.current = false;
    for (const source of activeSourcesRef.current) {
      try {
        source.stop();
      } catch {
        // Already stopped
      }
    }
    activeSourcesRef.current.clear();
    pendingChunksRef.current = [];
    nextStartTimeRef.current = 0;
    const ctx = ctxRef.current;
    ctxRef.current = null;
    setIsPlaying(false);
    if (ctx != null) {
      void ctx.close();
    }
  }, []);

  useEffect(() => {
    if (media == null) {
      stop();
      setIsFinished(false);
      setError(undefined);
      return undefined;
    }

    const mimeType = media.mimeType ?? "";
    const isRawPcm =
      mimeType === "audio/pcm" ||
      mimeType === "audio/L16" ||
      mimeType.startsWith("audio/pcm;") ||
      (pcmPrefixes != null &&
        pcmPrefixes.some((prefix) => mimeType.startsWith(prefix)));
    if (!isRawPcm) {
      setError(
        new Error(
          `useProgressiveAudio: unsupported mime type ${JSON.stringify(mimeType)}; expected audio/pcm. Fall back to useMediaURL.`
        )
      );
      return undefined;
    }

    setIsFinished(false);
    setError(undefined);

    const unsubscribe = attachToPump(media, (event) => {
      switch (event.type) {
        case "chunk":
          pendingChunksRef.current.push(event.bytes);
          if (shouldPlayRef.current) flushPending();
          break;
        case "finished":
          setIsFinished(true);
          break;
        case "error":
          setError(event.error);
          break;
      }
    });

    return () => {
      unsubscribe();
      stop();
    };
  }, [media, pcmPrefixes, flushPending, stop]);

  return { play, pause, stop, isPlaying, isFinished, error };
}

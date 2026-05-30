/* __LC_ALLOW_ENTRYPOINT_SIDE_EFFECTS__ */

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AudioMedia, MediaBase } from "@langchain/langgraph-sdk/stream";

/**
 * Lifecycle state of an audio or video player returned by
 * {@link useAudioPlayer} and {@link useVideoPlayer}.
 *
 * Single-enum design (vs. multiple booleans) eliminates impossible
 * states and gives callers a clean `switch` target.
 */
export type PlayerStatus =
  | "idle"
  | "buffering"
  | "playing"
  | "paused"
  | "finished"
  | "error";

/**
 * Options for {@link useAudioPlayer}.
 *
 * All fields optional; defaults cover OpenAI `gpt-4o-audio-preview`
 * pcm16 streams (`sampleRate: 24000`, `channels: 1`) and any WAV
 * stream the upstream model emits.
 */
export interface UseAudioPlayerOptions {
  /**
   * Begin playback as soon as the first byte arrives (PCM strategy)
   * or the blob settles (`element` strategy). Subject to browser
   * autoplay policies — on sites without prior user gesture, the
   * underlying `play()` may be rejected and the hook transitions to
   * `"error"` with a descriptive message.
   */
  autoPlay?: boolean;

  /**
   * Overrides for the PCM strategy. Ignored by the `element` strategy
   * and by WAV streams (the RIFF `fmt ` chunk is authoritative there).
   */
  pcm?: {
    /** Sample rate in Hz. Defaults to `24000`. */
    sampleRate?: number;
    /** Channel count. Defaults to `1` (mono). */
    channels?: number;
  };

  /**
   * Additional mime prefixes that should be treated as raw PCM16
   * (in addition to `audio/pcm` / `audio/L16`). Use when upstream
   * reports a custom mime like `audio/pcm16`.
   */
  pcmMimePrefixes?: readonly string[];

  /**
   * Force a specific playback strategy. Default `"auto"` picks `"pcm"`
   * for PCM / L16 / WAV mime types and `"element"` for everything else.
   */
  strategy?: "auto" | "pcm" | "element";
}

/**
 * Player controls + live state returned by {@link useAudioPlayer}.
 *
 * Shape is shared with {@link useVideoPlayer} where possible — learn
 * one surface, use it for both.
 */
export interface AudioPlayerHandle {
  /** Current lifecycle state. See {@link PlayerStatus}. */
  status: PlayerStatus;

  /**
   * Which implementation is active. `"pcm"` scheduling through
   * `AudioContext` starts within one chunk of the first byte; `"element"`
   * waits for `message-finish` before a hidden `HTMLAudioElement` takes
   * over.
   */
  strategy: "pcm" | "element";

  /** Start (or resume) playback. No-op while `status === "error"`. */
  play(): void;
  /** Pause without discarding buffered samples / element position. */
  pause(): void;
  /**
   * Hard stop: tears down the `AudioContext` (PCM) or detaches the
   * element (`element`) and drops any scheduled work.
   */
  stop(): void;
  /** Sugar for `status === "playing" ? pause() : play()`. */
  toggle(): void;
  /**
   * Reset back to `"idle"` and drop any transient error. The next
   * `play()` starts fresh from the current position.
   */
  reset(): void;
  /**
   * Resolve on the next terminal transition (`finished` | `paused` |
   * `idle`). Reject on transitions to `"error"`. Calling `stop()` or
   * `reset()` resolves the pending promise immediately. Calling
   * `playToEnd` also triggers `play()` if currently paused/idle.
   */
  playToEnd(): Promise<void>;

  /**
   * Seconds of audio consumed since the current `play()` call. Resets
   * on `reset()` and on media changes.
   */
  currentTime: number;

  /**
   * Total duration in seconds, when knowable. The `element` strategy
   * exposes this once `loadedmetadata` fires; the `pcm` strategy leaves
   * it `undefined` (PCM duration isn't known until `message-finish`).
   */
  duration?: number;

  /**
   * Seek to an absolute timestamp in seconds. Only defined on the
   * `element` strategy; `undefined` on `pcm` (random-access seeking of
   * a live scheduled buffer is not supported).
   */
  seek?(seconds: number): void;

  /**
   * RMS level of the last analysed frame, normalised to `[0, 1]`.
   * Drop-in for a VU meter. `0` when no analyser frame has been read
   * yet, when paused, or before `play()`.
   */
  level: number;

  /**
   * Current 256-bin frequency-domain snapshot from the internal
   * {@link AnalyserNode}. Returns `undefined` before the graph is
   * connected or on environments without Web Audio. Safe to poll
   * inside `requestAnimationFrame`.
   */
  getFrequencyData(): Uint8Array | undefined;

  /**
   * Current 256-sample waveform snapshot (byte time-domain) from the
   * internal {@link AnalyserNode}. Returns `undefined` before the graph
   * is connected or on environments without Web Audio.
   */
  getTimeDomainData(): Uint8Array | undefined;

  /** Last error raised by the stream reader, decoder, or element. */
  error: Error | undefined;
}

const DEFAULT_SAMPLE_RATE = 24_000;
const DEFAULT_CHANNELS = 1;
const ANALYSER_FFT_SIZE = 512;

/**
 * Per-stream audio format descriptor. Populated eagerly for raw PCM
 * streams and lazily (from the RIFF `fmt ` chunk) for WAV streams.
 * `scheduleChunk` and `ensureContext` both refuse to run until this
 * has been resolved.
 */
interface AudioFormat {
  readonly sampleRate: number;
  readonly channels: number;
  readonly bitsPerSample: number;
}

/**
 * Events fanned out from a shared pump controller to each hook
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
 * Keying on identity (WeakMap) gives us three properties for free:
 * - React StrictMode's simulated unmount/remount finds the same
 *   controller on re-attach, so we never `getReader()` twice on the
 *   same locked stream.
 * - New media instances get a fresh reader — no cross-talk.
 * - When callers drop their last reference to the media handle, the
 *   WeakMap entry is reclaimed alongside it.
 */
const pumpRegistry = new WeakMap<MediaBase, PumpController>();

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
  // a downstream consumer that mounts after the stream has already
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

type WavHeaderResult =
  | { readonly status: "need-more" }
  | { readonly status: "invalid"; readonly reason: string }
  | {
      readonly status: "parsed";
      readonly format: AudioFormat;
      /** Byte offset within the input where PCM samples begin. */
      readonly dataOffset: number;
    };

/**
 * Parse the RIFF/WAVE header of a WAV stream. Only the `fmt ` and `data`
 * chunks are interpreted; other chunks are skipped. The parser
 * requires the complete `fmt ` chunk and the `data` chunk header before
 * returning `"parsed"`, so callers may need several retries while
 * buffering incoming bytes. WAV uses little-endian integers throughout.
 */
function tryParseWavHeader(bytes: Uint8Array): WavHeaderResult {
  if (bytes.byteLength < 12) return { status: "need-more" };

  if (
    bytes[0] !== 0x52 ||
    bytes[1] !== 0x49 ||
    bytes[2] !== 0x46 ||
    bytes[3] !== 0x46 ||
    bytes[8] !== 0x57 ||
    bytes[9] !== 0x41 ||
    bytes[10] !== 0x56 ||
    bytes[11] !== 0x45
  ) {
    return { status: "invalid", reason: "not a RIFF/WAVE stream" };
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let fmt: {
    audioFormat: number;
    sampleRate: number;
    channels: number;
    bitsPerSample: number;
  } | null = null;

  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const id = String.fromCharCode(
      bytes[offset]!,
      bytes[offset + 1]!,
      bytes[offset + 2]!,
      bytes[offset + 3]!
    );
    const size = view.getUint32(offset + 4, true);
    const payloadStart = offset + 8;

    if (id === "fmt ") {
      if (payloadStart + 16 > bytes.byteLength) return { status: "need-more" };
      fmt = {
        audioFormat: view.getUint16(payloadStart, true),
        channels: view.getUint16(payloadStart + 2, true),
        sampleRate: view.getUint32(payloadStart + 4, true),
        bitsPerSample: view.getUint16(payloadStart + 14, true),
      };
      if (fmt.audioFormat !== 1) {
        return {
          status: "invalid",
          reason: `unsupported WAV audioFormat=${fmt.audioFormat} (expected 1, linear PCM)`,
        };
      }
      if (fmt.bitsPerSample !== 16) {
        return {
          status: "invalid",
          reason: `unsupported WAV bitsPerSample=${fmt.bitsPerSample} (expected 16)`,
        };
      }
    } else if (id === "data") {
      if (fmt == null) {
        return { status: "invalid", reason: "data chunk preceded fmt chunk" };
      }
      return {
        status: "parsed",
        format: {
          sampleRate: fmt.sampleRate,
          channels: fmt.channels,
          bitsPerSample: fmt.bitsPerSample,
        },
        dataOffset: payloadStart,
      };
    }

    // Chunks are word-aligned: an odd-sized payload carries one pad byte.
    offset = payloadStart + size + (size & 1);
  }

  return { status: "need-more" };
}

function concatChunks(chunks: readonly Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0]!;
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

function resolveAudioContextCtor(): typeof AudioContext | undefined {
  if (typeof window === "undefined") return undefined;
  return (
    (window as unknown as { AudioContext?: typeof AudioContext })
      .AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext
  );
}

/**
 * Decide which playback strategy the hook should use for a handle.
 * PCM16 / L16 / WAV flow through the progressive Web Audio path; every
 * other mime drops to a hidden `HTMLAudioElement`.
 */
function detectStrategy(
  mimeType: string | undefined,
  override: UseAudioPlayerOptions["strategy"],
  pcmPrefixes: readonly string[] | undefined
): "pcm" | "element" {
  if (override === "pcm" || override === "element") return override;
  const m = mimeType ?? "";
  const isPcm =
    m === "audio/pcm" ||
    m === "audio/L16" ||
    m.startsWith("audio/pcm;") ||
    m.startsWith("audio/L16;") ||
    m === "audio/wav" ||
    m === "audio/wave" ||
    m === "audio/x-wav" ||
    m === "audio/vnd.wave" ||
    (pcmPrefixes?.some((p) => m.startsWith(p)) ?? false);
  return isPcm ? "pcm" : "element";
}

/**
 * Progressive audio playback for {@link AudioMedia} handles with a
 * uniform surface across PCM (streamed) and container (`HTMLAudioElement`)
 * strategies.
 *
 * ### Behaviour
 *
 * - Strategy selection is derived from `media.mimeType` and may be
 *   overridden via `options.strategy`. PCM / L16 / WAV all flow through
 *   the progressive Web Audio path; every other mime uses a hidden
 *   `HTMLAudioElement`.
 *
 * - **PCM strategy.** Chunks are decoded in real time and scheduled on
 *   a single `AudioContext`; playback begins within one chunk of the
 *   first byte. `seek` / `duration` are `undefined` because random
 *   access on a live scheduled buffer is not supported.
 *
 * - **Element strategy.** `status` stays in `"buffering"` until
 *   `message-finish` materialises a blob URL; the element then owns
 *   playback. `seek` / `duration` are available.
 *
 * - Both strategies expose `level`, `getFrequencyData()`, and
 *   `getTimeDomainData()` by tapping an {@link AnalyserNode} in the
 *   audio graph.
 *
 * - React StrictMode's simulated unmount/remount is safe: the shared
 *   reader and replay buffer mean a second attach sees the same bytes
 *   that the first one did.
 *
 * @param media - Audio handle from `useAudio` etc.
 * @param options - Strategy overrides and PCM format hints.
 */
export function useAudioPlayer(
  media: AudioMedia | undefined,
  options?: UseAudioPlayerOptions
): AudioPlayerHandle {
  const sampleRate = options?.pcm?.sampleRate ?? DEFAULT_SAMPLE_RATE;
  const channels = options?.pcm?.channels ?? DEFAULT_CHANNELS;
  const pcmPrefixes = options?.pcmMimePrefixes;
  const strategyOverride = options?.strategy ?? "auto";
  const autoPlay = options?.autoPlay ?? false;

  const strategy: "pcm" | "element" = media
    ? detectStrategy(media.mimeType, strategyOverride, pcmPrefixes)
    : "element";

  const [status, setStatus] = useState<PlayerStatus>("idle");
  const [error, setError] = useState<Error | undefined>(undefined);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState<number | undefined>(undefined);
  const [level, setLevel] = useState(0);

  // ── Shared refs ─────────────────────────────────────────────────────
  const ctxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const freqBufRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const timeBufRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const rafRef = useRef<number | null>(null);
  const playStartCtxTimeRef = useRef<number>(0);

  // ── PCM strategy refs ───────────────────────────────────────────────
  const nextStartTimeRef = useRef<number>(0);
  const shouldPlayRef = useRef<boolean>(false);
  const pendingChunksRef = useRef<Uint8Array[]>([]);
  const activeSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const formatRef = useRef<AudioFormat | null>(null);
  const upstreamFinishedRef = useRef(false);

  // ── Element strategy refs ───────────────────────────────────────────
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const elementSourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const pendingSrcRef = useRef<string | undefined>(undefined);

  const statusRef = useRef<PlayerStatus>("idle");
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  // ── `playToEnd` bookkeeping ─────────────────────────────────────────
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

  // Fire pending resolvers whenever the status transitions to a
  // terminal state. Effect depends on `status` so it runs exactly once
  // per transition.
  useEffect(() => {
    if (status === "finished" || status === "paused" || status === "idle") {
      resolvePending();
    } else if (status === "error") {
      rejectPending(error ?? new Error("playback error"));
    }
  }, [status, error, resolvePending, rejectPending]);

  // ── Analyser loop ───────────────────────────────────────────────────
  const tickAnalyser = useCallback(() => {
    const analyser = analyserRef.current;
    const ctx = ctxRef.current;
    if (analyser == null) {
      rafRef.current = null;
      return;
    }
    const buf = timeBufRef.current;
    if (buf != null) {
      analyser.getByteTimeDomainData(buf);
      // RMS on bytes in [0, 255] centred at 128.
      let sum = 0;
      for (let i = 0; i < buf.length; i += 1) {
        const v = (buf[i]! - 128) / 128;
        sum += v * v;
      }
      setLevel(Math.sqrt(sum / buf.length));
    }
    if (ctx != null && statusRef.current === "playing") {
      setCurrentTime(ctx.currentTime - playStartCtxTimeRef.current);
    }
    if (typeof window !== "undefined") {
      rafRef.current = window.requestAnimationFrame(tickAnalyser);
    }
  }, []);

  const startAnalyserLoop = useCallback(() => {
    if (rafRef.current != null) return;
    if (typeof window === "undefined") return;
    rafRef.current = window.requestAnimationFrame(tickAnalyser);
  }, [tickAnalyser]);

  const stopAnalyserLoop = useCallback(() => {
    if (rafRef.current == null) return;
    if (typeof window !== "undefined") {
      window.cancelAnimationFrame(rafRef.current);
    }
    rafRef.current = null;
    setLevel(0);
  }, []);

  // ── AudioContext / AnalyserNode ─────────────────────────────────────
  const ensureAnalyser = useCallback((ctx: AudioContext): AnalyserNode => {
    if (analyserRef.current != null) return analyserRef.current;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = ANALYSER_FFT_SIZE;
    analyser.connect(ctx.destination);
    analyserRef.current = analyser;
    freqBufRef.current = new Uint8Array(analyser.frequencyBinCount);
    timeBufRef.current = new Uint8Array(analyser.fftSize);
    return analyser;
  }, []);

  const ensureContextForPcm = useCallback((): AudioContext | null => {
    if (ctxRef.current != null) return ctxRef.current;
    const format = formatRef.current;
    if (format == null) return null;
    const AudioCtx = resolveAudioContextCtor();
    if (AudioCtx == null) {
      setError(new Error("Web Audio API is not available in this environment"));
      setStatus("error");
      return null;
    }
    const ctx = new AudioCtx({ sampleRate: format.sampleRate });
    ctxRef.current = ctx;
    nextStartTimeRef.current = ctx.currentTime;
    ensureAnalyser(ctx);
    return ctx;
  }, [ensureAnalyser]);

  const ensureContextForElement = useCallback((): AudioContext | null => {
    if (ctxRef.current != null) return ctxRef.current;
    const AudioCtx = resolveAudioContextCtor();
    if (AudioCtx == null) return null;
    // Match device rate — browsers otherwise resample the element.
    const ctx = new AudioCtx();
    ctxRef.current = ctx;
    ensureAnalyser(ctx);
    return ctx;
  }, [ensureAnalyser]);

  // ── PCM scheduling ──────────────────────────────────────────────────
  const scheduleChunk = useCallback((ctx: AudioContext, bytes: Uint8Array) => {
    const format = formatRef.current;
    const analyser = analyserRef.current;
    if (format == null || analyser == null) return;
    const { sampleRate: bufSampleRate, channels: bufChannels } = format;

    const sampleCount = Math.floor(bytes.byteLength / 2);
    if (sampleCount === 0) return;
    const framesPerChannel = Math.floor(sampleCount / bufChannels);
    if (framesPerChannel === 0) return;

    const buffer = ctx.createBuffer(
      bufChannels,
      framesPerChannel,
      bufSampleRate
    );
    const view = new DataView(
      bytes.buffer,
      bytes.byteOffset,
      framesPerChannel * bufChannels * 2
    );
    for (let channel = 0; channel < bufChannels; channel += 1) {
      const channelData = buffer.getChannelData(channel);
      for (let frame = 0; frame < framesPerChannel; frame += 1) {
        const sampleOffset = (frame * bufChannels + channel) * 2;
        const int = view.getInt16(sampleOffset, true);
        channelData[frame] = int < 0 ? int / 0x8000 : int / 0x7fff;
      }
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(analyser);
    const now = ctx.currentTime;
    const startAt = Math.max(now, nextStartTimeRef.current);
    source.start(startAt);
    nextStartTimeRef.current = startAt + buffer.duration;
    activeSourcesRef.current.add(source);
    source.onended = () => {
      activeSourcesRef.current.delete(source);
      if (
        activeSourcesRef.current.size === 0 &&
        upstreamFinishedRef.current &&
        pendingChunksRef.current.length === 0
      ) {
        setStatus("finished");
      }
    };
  }, []);

  const flushPendingPcm = useCallback(() => {
    if (!shouldPlayRef.current) return;
    const ctx = ensureContextForPcm();
    if (ctx == null) return;
    if (ctx.state === "suspended") void ctx.resume();
    const chunks = pendingChunksRef.current;
    pendingChunksRef.current = [];
    for (const bytes of chunks) scheduleChunk(ctx, bytes);
    if (chunks.length > 0 && statusRef.current !== "playing") {
      playStartCtxTimeRef.current = ctx.currentTime;
      setCurrentTime(0);
      setStatus("playing");
      startAnalyserLoop();
    }
  }, [ensureContextForPcm, scheduleChunk, startAnalyserLoop]);

  // ── Public controls ─────────────────────────────────────────────────
  const play = useCallback(() => {
    if (media == null) return;
    if (statusRef.current === "error") return;

    if (strategy === "pcm") {
      shouldPlayRef.current = true;
      if (statusRef.current !== "playing") setStatus("buffering");
      const ctx = ensureContextForPcm();
      if (ctx != null && ctx.state === "suspended") void ctx.resume();
      flushPendingPcm();
      return;
    }

    // element strategy
    const audio = audioElRef.current;
    if (audio == null) {
      // Buffer hasn't materialised yet — remember the intent and let
      // the blob-ready path below start playback.
      shouldPlayRef.current = true;
      setStatus("buffering");
      return;
    }
    shouldPlayRef.current = true;
    const ctx = ensureContextForElement();
    if (ctx != null && ctx.state === "suspended") void ctx.resume();
    audio.play().catch((err) => {
      setError(err as Error);
      setStatus("error");
    });
  }, [
    media,
    strategy,
    ensureContextForPcm,
    ensureContextForElement,
    flushPendingPcm,
  ]);

  const pause = useCallback(() => {
    shouldPlayRef.current = false;
    if (strategy === "pcm") {
      const ctx = ctxRef.current;
      if (ctx != null && ctx.state === "running") void ctx.suspend();
    } else {
      audioElRef.current?.pause();
    }
    if (statusRef.current === "playing" || statusRef.current === "buffering") {
      setStatus("paused");
    }
  }, [strategy]);

  const stop = useCallback(() => {
    shouldPlayRef.current = false;
    stopAnalyserLoop();

    if (strategy === "pcm") {
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
    } else {
      const audio = audioElRef.current;
      if (audio != null) {
        audio.pause();
        audio.currentTime = 0;
      }
    }

    const ctx = ctxRef.current;
    ctxRef.current = null;
    analyserRef.current = null;
    freqBufRef.current = null;
    timeBufRef.current = null;
    elementSourceRef.current = null;
    if (ctx != null) void ctx.close();

    setCurrentTime(0);
    setStatus(media == null ? "idle" : "paused");
  }, [strategy, media, stopAnalyserLoop]);

  const reset = useCallback(() => {
    stop();
    setError(undefined);
    setDuration(undefined);
    upstreamFinishedRef.current = false;
    setStatus("idle");
  }, [stop]);

  const toggle = useCallback(() => {
    if (statusRef.current === "playing") pause();
    else play();
  }, [play, pause]);

  const playToEnd = useCallback((): Promise<void> => {
    // Drop any prior caller — they'd have resolved on the next
    // terminal anyway, which is about to happen again.
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
      if (strategy !== "element") return;
      const audio = audioElRef.current;
      if (audio == null) return;
      audio.currentTime = seconds;
      setCurrentTime(seconds);
    },
    [strategy]
  );

  const getFrequencyData = useCallback((): Uint8Array | undefined => {
    const analyser = analyserRef.current;
    const buf = freqBufRef.current;
    if (analyser == null || buf == null) return undefined;
    analyser.getByteFrequencyData(buf);
    return buf;
  }, []);

  const getTimeDomainData = useCallback((): Uint8Array | undefined => {
    const analyser = analyserRef.current;
    const buf = timeBufRef.current;
    if (analyser == null || buf == null) return undefined;
    analyser.getByteTimeDomainData(buf);
    return buf;
  }, []);

  // ── Media binding ───────────────────────────────────────────────────
  const autoPlayRef = useRef(autoPlay);
  useEffect(() => {
    autoPlayRef.current = autoPlay;
  }, [autoPlay]);

  // Surface a media-level error as soon as the handle reports one.
  useEffect(() => {
    if (media?.error == null) return;
    setError(new Error(media.error.message));
    setStatus("error");
  }, [media]);

  // PCM effect — lifts from upstream stream → `AudioContext`.
  useEffect(() => {
    if (media == null || strategy !== "pcm") return undefined;

    setError(undefined);
    setStatus("buffering");
    setCurrentTime(0);
    setDuration(undefined);
    upstreamFinishedRef.current = false;
    pendingChunksRef.current = [];

    const mimeType = media.mimeType ?? "";
    const isRawPcm =
      mimeType === "audio/pcm" ||
      mimeType === "audio/L16" ||
      mimeType.startsWith("audio/pcm;") ||
      mimeType.startsWith("audio/L16;") ||
      (pcmPrefixes != null &&
        pcmPrefixes.some((prefix) => mimeType.startsWith(prefix)));
    const isWav =
      mimeType === "audio/wav" ||
      mimeType === "audio/wave" ||
      mimeType === "audio/x-wav" ||
      mimeType === "audio/vnd.wave";

    if (isRawPcm) {
      formatRef.current = {
        sampleRate,
        channels,
        bitsPerSample: 16,
      };
    } else if (isWav) {
      formatRef.current = null;
    } else {
      // Explicit `strategy: "pcm"` override on a non-PCM mime: fail loud.
      setError(
        new Error(
          `useAudioPlayer: forced PCM strategy for unsupported mime ${JSON.stringify(mimeType)}`
        )
      );
      setStatus("error");
      return undefined;
    }

    // WAV parser state (ignored on the PCM path). Accumulate inbound
    // bytes until the RIFF chunks resolve, then flip to passthrough.
    const wavHeaderChunks: Uint8Array[] = [];
    let wavHeaderParsed = !isWav;
    let wavHeaderFailed = false;

    const routeChunk = (bytes: Uint8Array) => {
      if (wavHeaderFailed) return;

      if (wavHeaderParsed) {
        pendingChunksRef.current.push(bytes);
        if (shouldPlayRef.current) flushPendingPcm();
        return;
      }

      wavHeaderChunks.push(bytes);
      const combined = concatChunks(wavHeaderChunks);
      const result = tryParseWavHeader(combined);
      if (result.status === "need-more") return;
      if (result.status === "invalid") {
        wavHeaderFailed = true;
        setError(
          new Error(`useAudioPlayer: invalid WAV stream: ${result.reason}`)
        );
        setStatus("error");
        return;
      }

      formatRef.current = result.format;
      wavHeaderParsed = true;
      wavHeaderChunks.length = 0;

      const tail = combined.subarray(result.dataOffset);
      if (tail.byteLength > 0) {
        pendingChunksRef.current.push(tail);
        if (shouldPlayRef.current) flushPendingPcm();
      }
    };

    if (autoPlayRef.current) {
      shouldPlayRef.current = true;
    }

    const unsubscribe = attachToPump(media, (event) => {
      switch (event.type) {
        case "chunk":
          routeChunk(event.bytes);
          break;
        case "finished":
          upstreamFinishedRef.current = true;
          if (
            pendingChunksRef.current.length === 0 &&
            activeSourcesRef.current.size === 0
          ) {
            setStatus("finished");
          }
          break;
        case "error":
          setError(event.error);
          setStatus("error");
          break;
      }
    });

    return () => {
      unsubscribe();
      stop();
    };
    // `flushPendingPcm` and `stop` are stable via useCallback deps;
    // include them to satisfy exhaustive-deps without re-running.
  }, [
    media,
    strategy,
    sampleRate,
    channels,
    pcmPrefixes,
    flushPendingPcm,
    stop,
  ]);

  // Element effect — await blob URL then wire an HTMLAudioElement.
  useEffect(() => {
    if (media == null || strategy !== "element") return undefined;
    if (typeof window === "undefined") return undefined;

    setError(undefined);
    setStatus("buffering");
    setCurrentTime(0);
    setDuration(undefined);

    let cancelled = false;
    let audio: HTMLAudioElement | null = null;

    media.objectURL.then(
      (resolved) => {
        if (cancelled) return;
        pendingSrcRef.current = resolved;
        audio = new Audio(resolved);
        audio.preload = "auto";
        audioElRef.current = audio;

        const onPlay = () => {
          if (statusRef.current === "error") return;
          const ctx = ensureContextForElement();
          if (
            ctx != null &&
            elementSourceRef.current == null &&
            audio != null
          ) {
            try {
              const src = ctx.createMediaElementSource(audio);
              src.connect(analyserRef.current!);
              elementSourceRef.current = src;
            } catch {
              // Some browsers reject a second `createMediaElementSource`
              // on the same element; fall through without visualization.
            }
          }
          playStartCtxTimeRef.current = 0;
          setCurrentTime(audio?.currentTime ?? 0);
          setStatus("playing");
          startAnalyserLoop();
        };
        const onPause = () => {
          if (audio != null && audio.ended) return; // ended fires pause too
          if (statusRef.current === "playing") setStatus("paused");
        };
        const onEnded = () => {
          setStatus("finished");
        };
        const onTimeUpdate = () => {
          if (audio != null) setCurrentTime(audio.currentTime);
        };
        const onLoadedMetadata = () => {
          if (audio != null && Number.isFinite(audio.duration)) {
            setDuration(audio.duration);
          }
        };
        const onError = () => {
          setError(new Error("HTMLAudioElement error"));
          setStatus("error");
        };

        audio.addEventListener("play", onPlay);
        audio.addEventListener("pause", onPause);
        audio.addEventListener("ended", onEnded);
        audio.addEventListener("timeupdate", onTimeUpdate);
        audio.addEventListener("loadedmetadata", onLoadedMetadata);
        audio.addEventListener("error", onError);

        if (shouldPlayRef.current || autoPlayRef.current) {
          audio.play().catch((err) => {
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

    return () => {
      cancelled = true;
      const el = audioElRef.current;
      audioElRef.current = null;
      elementSourceRef.current = null;
      if (el != null) {
        try {
          el.pause();
          el.removeAttribute("src");
          el.load();
        } catch {
          // best-effort teardown
        }
      }
      stop();
      try {
        media.revoke();
      } catch {
        // best-effort
      }
    };
  }, [media, strategy, ensureContextForElement, startAnalyserLoop, stop]);

  // Reset state when the media handle is cleared.
  useEffect(() => {
    if (media != null) return;
    setStatus("idle");
    setError(undefined);
    setCurrentTime(0);
    setDuration(undefined);
    setLevel(0);
    upstreamFinishedRef.current = false;
  }, [media]);

  return {
    status,
    strategy,
    play,
    pause,
    stop,
    toggle,
    reset,
    playToEnd,
    currentTime,
    duration: strategy === "element" ? duration : undefined,
    seek: strategy === "element" ? seek : undefined,
    level,
    getFrequencyData,
    getTimeDomainData,
    error,
  };
}

import { onDestroy } from "svelte";
import type { AudioMedia, MediaBase } from "@langchain/langgraph-sdk/stream";
import type { ValueOrGetter } from "./use-projection.svelte.js";

/**
 * Lifecycle state of an audio or video player returned by
 * {@link useAudioPlayer} and `useVideoPlayer`.
 */
export type PlayerStatus =
  | "idle"
  | "buffering"
  | "playing"
  | "paused"
  | "finished"
  | "error";

/** Options for {@link useAudioPlayer}. */
export interface UseAudioPlayerOptions {
  /**
   * Begin playback as soon as the first byte arrives (PCM strategy)
   * or the blob settles (`element` strategy). Subject to browser
   * autoplay policies — on sites without a prior user gesture the
   * underlying `play()` may be rejected and the hook transitions to
   * `"error"`.
   */
  autoPlay?: boolean;
  /** Overrides for the PCM strategy. Ignored by `element` / WAV. */
  pcm?: {
    /** Sample rate in Hz. Defaults to `24000`. */
    sampleRate?: number;
    /** Channel count. Defaults to `1` (mono). */
    channels?: number;
  };
  /** Additional mime prefixes treated as raw PCM16. */
  pcmMimePrefixes?: readonly string[];
  /** Force a specific playback strategy. Default `"auto"`. */
  strategy?: "auto" | "pcm" | "element";
}

/**
 * Player controls + live state returned by {@link useAudioPlayer}.
 *
 * Live state is exposed via getters on a stable object so templates
 * can read `player.status` / `player.currentTime` without a `.value`
 * hop. Imperative controls are plain functions.
 */
export interface AudioPlayerHandle {
  readonly status: PlayerStatus;
  readonly strategy: "pcm" | "element";
  play(): void;
  pause(): void;
  stop(): void;
  toggle(): void;
  reset(): void;
  playToEnd(): Promise<void>;
  readonly currentTime: number;
  readonly duration: number | undefined;
  seek(seconds: number): void;
  /** RMS level of the last analysed frame, `[0, 1]`. */
  readonly level: number;
  getFrequencyData(): Uint8Array | undefined;
  getTimeDomainData(): Uint8Array | undefined;
  readonly error: Error | undefined;
}

const DEFAULT_SAMPLE_RATE = 24_000;
const DEFAULT_CHANNELS = 1;
const ANALYSER_FFT_SIZE = 512;

interface AudioFormat {
  readonly sampleRate: number;
  readonly channels: number;
  readonly bitsPerSample: number;
}

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
 * identity. Keying on identity (WeakMap) keeps the pump stable
 * across remounts and simultaneous consumers while letting GC
 * reclaim entries alongside their media handles.
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
      readonly dataOffset: number;
    };

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

function unwrap<T>(input: ValueOrGetter<T>): T {
  if (typeof input === "function") return (input as () => T)();
  return input;
}

/**
 * Progressive audio playback for {@link AudioMedia} handles with a
 * uniform surface across PCM (streamed) and container
 * (`HTMLAudioElement`) strategies.
 *
 * The Svelte binding mirrors the React / Vue equivalents: reactive
 * state is exposed as getters on the returned handle and templates
 * read `player.status` / `player.currentTime` directly.
 *
 * @param media   - Audio handle from `useAudio` (plain value or getter).
 * @param options - Strategy overrides and PCM format hints.
 */
export function useAudioPlayer(
  media: ValueOrGetter<AudioMedia | undefined>,
  options?: UseAudioPlayerOptions
): AudioPlayerHandle {
  const sampleRate = options?.pcm?.sampleRate ?? DEFAULT_SAMPLE_RATE;
  const channels = options?.pcm?.channels ?? DEFAULT_CHANNELS;
  const pcmPrefixes = options?.pcmMimePrefixes;
  const strategyOverride = options?.strategy ?? "auto";
  const autoPlay = options?.autoPlay ?? false;

  let status = $state<PlayerStatus>("idle");
  let error = $state<Error | undefined>(undefined);
  let currentTime = $state(0);
  let duration = $state<number | undefined>(undefined);
  let level = $state(0);
  let strategyState = $state<"pcm" | "element">("element");

  // ── Shared state (not reactive) ─────────────────────────────────────
  let ctx: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let freqBuf: Uint8Array<ArrayBuffer> | null = null;
  let timeBuf: Uint8Array<ArrayBuffer> | null = null;
  let rafHandle: number | null = null;
  let playStartCtxTime = 0;

  // ── PCM strategy state ──────────────────────────────────────────────
  let nextStartTime = 0;
  let shouldPlay = false;
  let pendingChunks: Uint8Array[] = [];
  const activeSources = new Set<AudioBufferSourceNode>();
  let format: AudioFormat | null = null;
  let upstreamFinished = false;

  // ── Element strategy state ──────────────────────────────────────────
  let audioEl: HTMLAudioElement | null = null;
  let elementSource: MediaElementAudioSourceNode | null = null;

  // ── `playToEnd` bookkeeping ─────────────────────────────────────────
  let pendingResolve: (() => void) | null = null;
  let pendingReject: ((err: Error) => void) | null = null;

  const resolvePending = () => {
    const resolve = pendingResolve;
    pendingResolve = null;
    pendingReject = null;
    resolve?.();
  };
  const rejectPending = (err: Error) => {
    const reject = pendingReject;
    pendingResolve = null;
    pendingReject = null;
    reject?.(err);
  };

  // Fire pending resolvers whenever status enters a terminal state.
  $effect(() => {
    const s = status;
    if (s === "finished" || s === "paused" || s === "idle") {
      resolvePending();
    } else if (s === "error") {
      rejectPending(error ?? new Error("playback error"));
    }
  });

  // ── Analyser loop ───────────────────────────────────────────────────
  const tickAnalyser = () => {
    if (analyser == null) {
      rafHandle = null;
      return;
    }
    if (timeBuf != null) {
      analyser.getByteTimeDomainData(timeBuf);
      let sum = 0;
      for (let i = 0; i < timeBuf.length; i += 1) {
        const v = (timeBuf[i]! - 128) / 128;
        sum += v * v;
      }
      level = Math.sqrt(sum / timeBuf.length);
    }
    if (ctx != null && status === "playing") {
      currentTime = ctx.currentTime - playStartCtxTime;
    }
    if (typeof window !== "undefined") {
      rafHandle = window.requestAnimationFrame(tickAnalyser);
    }
  };

  const startAnalyserLoop = () => {
    if (rafHandle != null) return;
    if (typeof window === "undefined") return;
    rafHandle = window.requestAnimationFrame(tickAnalyser);
  };

  const stopAnalyserLoop = () => {
    if (rafHandle == null) return;
    if (typeof window !== "undefined") {
      window.cancelAnimationFrame(rafHandle);
    }
    rafHandle = null;
    level = 0;
  };

  // ── AudioContext / AnalyserNode ─────────────────────────────────────
  const ensureAnalyser = (context: AudioContext): AnalyserNode => {
    if (analyser != null) return analyser;
    const node = context.createAnalyser();
    node.fftSize = ANALYSER_FFT_SIZE;
    node.connect(context.destination);
    analyser = node;
    freqBuf = new Uint8Array(node.frequencyBinCount);
    timeBuf = new Uint8Array(node.fftSize);
    return node;
  };

  const ensureContextForPcm = (): AudioContext | null => {
    if (ctx != null) return ctx;
    if (format == null) return null;
    const AudioCtx = resolveAudioContextCtor();
    if (AudioCtx == null) {
      error = new Error("Web Audio API is not available in this environment");
      status = "error";
      return null;
    }
    const context = new AudioCtx({ sampleRate: format.sampleRate });
    ctx = context;
    nextStartTime = context.currentTime;
    ensureAnalyser(context);
    return context;
  };

  const ensureContextForElement = (): AudioContext | null => {
    if (ctx != null) return ctx;
    const AudioCtx = resolveAudioContextCtor();
    if (AudioCtx == null) return null;
    const context = new AudioCtx();
    ctx = context;
    ensureAnalyser(context);
    return context;
  };

  // ── PCM scheduling ──────────────────────────────────────────────────
  const scheduleChunk = (context: AudioContext, bytes: Uint8Array) => {
    if (format == null || analyser == null) return;
    const { sampleRate: bufSampleRate, channels: bufChannels } = format;

    const sampleCount = Math.floor(bytes.byteLength / 2);
    if (sampleCount === 0) return;
    const framesPerChannel = Math.floor(sampleCount / bufChannels);
    if (framesPerChannel === 0) return;

    const buffer = context.createBuffer(
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

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(analyser);
    const now = context.currentTime;
    const startAt = Math.max(now, nextStartTime);
    source.start(startAt);
    nextStartTime = startAt + buffer.duration;
    activeSources.add(source);
    source.onended = () => {
      activeSources.delete(source);
      if (
        activeSources.size === 0 &&
        upstreamFinished &&
        pendingChunks.length === 0
      ) {
        status = "finished";
      }
    };
  };

  const flushPendingPcm = () => {
    if (!shouldPlay) return;
    const context = ensureContextForPcm();
    if (context == null) return;
    if (context.state === "suspended") void context.resume();
    const chunks = pendingChunks;
    pendingChunks = [];
    for (const bytes of chunks) scheduleChunk(context, bytes);
    if (chunks.length > 0 && status !== "playing") {
      playStartCtxTime = context.currentTime;
      currentTime = 0;
      status = "playing";
      startAnalyserLoop();
    }
  };

  // ── Public controls ─────────────────────────────────────────────────
  const play = () => {
    const m = unwrap(media);
    if (m == null) return;
    if (status === "error") return;

    if (strategyState === "pcm") {
      shouldPlay = true;
      if (status !== "playing") status = "buffering";
      const context = ensureContextForPcm();
      if (context != null && context.state === "suspended") {
        void context.resume();
      }
      flushPendingPcm();
      return;
    }

    if (audioEl == null) {
      shouldPlay = true;
      status = "buffering";
      return;
    }
    shouldPlay = true;
    const context = ensureContextForElement();
    if (context != null && context.state === "suspended") {
      void context.resume();
    }
    audioEl.play().catch((err) => {
      error = err as Error;
      status = "error";
    });
  };

  const pause = () => {
    shouldPlay = false;
    if (strategyState === "pcm") {
      if (ctx != null && ctx.state === "running") void ctx.suspend();
    } else {
      audioEl?.pause();
    }
    if (status === "playing" || status === "buffering") {
      status = "paused";
    }
  };

  const stop = () => {
    shouldPlay = false;
    stopAnalyserLoop();

    if (strategyState === "pcm") {
      for (const source of activeSources) {
        try {
          source.stop();
        } catch {
          // Already stopped
        }
      }
      activeSources.clear();
      pendingChunks = [];
      nextStartTime = 0;
    } else if (audioEl != null) {
      audioEl.pause();
      audioEl.currentTime = 0;
    }

    const context = ctx;
    ctx = null;
    analyser = null;
    freqBuf = null;
    timeBuf = null;
    elementSource = null;
    if (context != null) void context.close();

    currentTime = 0;
    status = unwrap(media) == null ? "idle" : "paused";
  };

  const reset = () => {
    stop();
    error = undefined;
    duration = undefined;
    upstreamFinished = false;
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
    if (strategyState !== "element") return;
    if (audioEl == null) return;
    audioEl.currentTime = seconds;
    currentTime = seconds;
  };

  const getFrequencyData = (): Uint8Array | undefined => {
    if (analyser == null || freqBuf == null) return undefined;
    analyser.getByteFrequencyData(freqBuf);
    return freqBuf;
  };

  const getTimeDomainData = (): Uint8Array | undefined => {
    if (analyser == null || timeBuf == null) return undefined;
    analyser.getByteTimeDomainData(timeBuf);
    return timeBuf;
  };

  // ── Media binding ───────────────────────────────────────────────────
  let detachPcm: (() => void) | null = null;
  let detachElement: (() => void) | null = null;

  const teardownBinding = () => {
    detachPcm?.();
    detachPcm = null;
    detachElement?.();
    detachElement = null;
    const el = audioEl;
    audioEl = null;
    elementSource = null;
    if (el != null) {
      try {
        el.pause();
        el.removeAttribute("src");
        el.load();
      } catch {
        // best-effort teardown
      }
    }
  };

  const bindPcm = (m: AudioMedia) => {
    error = undefined;
    status = "buffering";
    currentTime = 0;
    duration = undefined;
    upstreamFinished = false;
    pendingChunks = [];

    const mimeType = m.mimeType ?? "";
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
      format = { sampleRate, channels, bitsPerSample: 16 };
    } else if (isWav) {
      format = null;
    } else {
      error = new Error(
        `useAudioPlayer: forced PCM strategy for unsupported mime ${JSON.stringify(mimeType)}`
      );
      status = "error";
      return () => {};
    }

    const wavHeaderChunks: Uint8Array[] = [];
    let wavHeaderParsed = !isWav;
    let wavHeaderFailed = false;

    const routeChunk = (bytes: Uint8Array) => {
      if (wavHeaderFailed) return;

      if (wavHeaderParsed) {
        pendingChunks.push(bytes);
        if (shouldPlay) flushPendingPcm();
        return;
      }

      wavHeaderChunks.push(bytes);
      const combined = concatChunks(wavHeaderChunks);
      const result = tryParseWavHeader(combined);
      if (result.status === "need-more") return;
      if (result.status === "invalid") {
        wavHeaderFailed = true;
        error = new Error(
          `useAudioPlayer: invalid WAV stream: ${result.reason}`
        );
        status = "error";
        return;
      }

      format = result.format;
      wavHeaderParsed = true;
      wavHeaderChunks.length = 0;

      const tail = combined.subarray(result.dataOffset);
      if (tail.byteLength > 0) {
        pendingChunks.push(tail);
        if (shouldPlay) flushPendingPcm();
      }
    };

    if (autoPlay) shouldPlay = true;

    return attachToPump(m, (event) => {
      switch (event.type) {
        case "chunk":
          routeChunk(event.bytes);
          break;
        case "finished":
          upstreamFinished = true;
          if (pendingChunks.length === 0 && activeSources.size === 0) {
            status = "finished";
          }
          break;
        case "error":
          error = event.error;
          status = "error";
          break;
      }
    });
  };

  const bindElement = (m: AudioMedia): (() => void) => {
    if (typeof window === "undefined") return () => {};
    error = undefined;
    status = "buffering";
    currentTime = 0;
    duration = undefined;

    let cancelled = false;

    m.objectURL.then(
      (resolved) => {
        if (cancelled) return;
        audioEl = new Audio(resolved);
        audioEl.preload = "auto";

        const el = audioEl;
        const onPlay = () => {
          if (status === "error") return;
          const context = ensureContextForElement();
          if (context != null && elementSource == null && el != null) {
            try {
              const src = context.createMediaElementSource(el);
              src.connect(analyser!);
              elementSource = src;
            } catch {
              // Some browsers reject a second createMediaElementSource
              // on the same element; fall through without visualization.
            }
          }
          playStartCtxTime = 0;
          currentTime = el?.currentTime ?? 0;
          status = "playing";
          startAnalyserLoop();
        };
        const onPause = () => {
          if (el != null && el.ended) return;
          if (status === "playing") status = "paused";
        };
        const onEnded = () => {
          status = "finished";
        };
        const onTimeUpdate = () => {
          if (el != null) currentTime = el.currentTime;
        };
        const onLoadedMetadata = () => {
          if (el != null && Number.isFinite(el.duration)) {
            duration = el.duration;
          }
        };
        const onError = () => {
          error = new Error("HTMLAudioElement error");
          status = "error";
        };

        el.addEventListener("play", onPlay);
        el.addEventListener("pause", onPause);
        el.addEventListener("ended", onEnded);
        el.addEventListener("timeupdate", onTimeUpdate);
        el.addEventListener("loadedmetadata", onLoadedMetadata);
        el.addEventListener("error", onError);

        if (shouldPlay || autoPlay) {
          el.play().catch((err) => {
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

    return () => {
      cancelled = true;
      try {
        m.revoke();
      } catch {
        // best-effort
      }
    };
  };

  // React to media changes + re-establish bindings.
  $effect(() => {
    const m = unwrap(media);
    teardownBinding();

    if (m == null) {
      status = "idle";
      error = undefined;
      currentTime = 0;
      duration = undefined;
      level = 0;
      upstreamFinished = false;
      return;
    }

    strategyState = detectStrategy(m.mimeType, strategyOverride, pcmPrefixes);

    if (m.error != null) {
      error = new Error(m.error.message);
      status = "error";
      return;
    }

    if (strategyState === "pcm") {
      detachPcm = bindPcm(m) ?? null;
    } else {
      detachElement = bindElement(m);
    }
  });

  onDestroy(() => {
    teardownBinding();
    stop();
  });

  return {
    get status() {
      return status;
    },
    get strategy() {
      return strategyState;
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
    get level() {
      return level;
    },
    getFrequencyData,
    getTimeDomainData,
    get error() {
      return error;
    },
  };
}

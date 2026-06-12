import type {
  AudioContentBlock,
  ContentBlock,
  FileContentBlock,
  ImageContentBlock,
  MessagesEvent,
  VideoContentBlock,
} from "@langchain/protocol";

/**
 * Block types this assembler knows how to reassemble into media handles.
 */
export type MediaBlockType = "audio" | "image" | "video" | "file";

const MEDIA_BLOCK_TYPES: ReadonlySet<string> = new Set<MediaBlockType>([
  "audio",
  "image",
  "video",
  "file",
]);

/**
 * Kinds of failure that can terminate a media handle prematurely.
 *
 * - `"message-error"` — the upstream message emitted an `error` event
 *   before completion.
 * - `"stream-closed"` — the transport stream closed before
 *   `message-finish` arrived (thread closed, transport dropped, etc.).
 * - `"fetch-failed"` — the block was `url`-sourced and the lazy
 *   `fetch()` rejected (CORS, 404, 5xx, network).
 */
export type MediaAssemblyErrorKind =
  | "message-error"
  | "stream-closed"
  | "fetch-failed";

/**
 * Typed error thrown through `media.stream` / rejected from
 * `media.blob` / `media.objectURL` when a handle fails before its
 * message completes. Carries the bytes accumulated up to the failure
 * point on `partialBytes` for callers that want to salvage or diagnose.
 */
export class MediaAssemblyError extends Error {
  readonly kind: MediaAssemblyErrorKind;
  readonly messageId: string;
  readonly partialBytes: Uint8Array;
  // oxlint-disable-next-line typescript/no-explicit-any
  readonly cause?: unknown;

  constructor(
    kind: MediaAssemblyErrorKind,
    messageId: string,
    partialBytes: Uint8Array,
    message?: string,
    options?: { cause?: unknown }
  ) {
    super(message ?? `media ${kind} for message ${messageId}`);
    this.name = "MediaAssemblyError";
    this.kind = kind;
    this.messageId = messageId;
    this.partialBytes = partialBytes;
    this.cause = options?.cause;
  }
}

/**
 * Shared surface across every media handle returned by
 * {@link MediaAssembler}.
 *
 * The handle is live while its parent message is active:
 *  - `partialBytes` is a snapshot of all bytes received so far.
 *  - `stream` is a lazy, single-consumer byte stream (see
 *    accessor docstring).
 *  - `blob` / `objectURL` settle on `message-finish`.
 *  - `error` becomes set if the handle terminates in any of the
 *    {@link MediaAssemblyErrorKind} failure modes.
 */
export interface MediaBase {
  readonly messageId: string;
  readonly namespace: string[];
  readonly node?: string;
  /** `id` from the originating content block, if the provider sent one. */
  readonly id?: string;
  readonly mimeType?: string;
  /**
   * Present iff the originating block carried `url` (not `data`).
   * When set, `blob` / `stream` / `objectURL` lazily fetch from here
   * on first access.
   */
  readonly url?: string;

  /**
   * Live byte stream.
   *
   * Lazy: not materialised unless accessed. On first access the
   * stream is seeded with every byte already accumulated
   * (`partialBytes`) and then wired to future chunks. For URL-sourced
   * blocks, first access triggers `fetch()` and pipes the response
   * body through.
   *
   * Repeated access returns the same {@link ReadableStream} reference
   * — you can safely read it once, release the lock, and re-acquire a
   * reader later (e.g. React StrictMode effect re-invokes). The
   * standard `ReadableStream.locked` semantics prevent concurrent
   * readers; use `stream.tee()` when you truly need multiple live
   * consumers.
   */
  readonly stream: ReadableStream<Uint8Array>;

  /** Resolves on `message-finish` with the concatenated {@link Blob}. */
  readonly blob: Promise<Blob>;

  /**
   * Lazy {@link URL.createObjectURL} over {@link blob}. Cached: first
   * access creates the URL, subsequent accesses return the same one.
   * Call {@link revoke} to free the URL slot; the next access creates
   * a fresh URL. `ThreadStream.close()` auto-revokes as a safety net.
   */
  readonly objectURL: Promise<string>;

  /** Live view of accumulated bytes. Settles with final bytes on finish. */
  readonly partialBytes: Uint8Array;

  /** Set iff the handle settled in an error state. */
  readonly error?: MediaAssemblyError;

  /** Diagnostic: `false` if block indices arrived out of order. */
  readonly monotonic: boolean;

  /**
   * Revoke the currently-cached object URL (if any). Subsequent
   * accesses to {@link objectURL} create a fresh URL from the Blob.
   * Idempotent.
   */
  revoke(): void;
}

export interface AudioMedia extends MediaBase {
  readonly type: "audio";
  /**
   * Concatenated transcript across every audio block in this message.
   * Resolves on `message-finish` with the joined string, or `undefined`
   * when no block carried a transcript.
   */
  readonly transcript: Promise<string | undefined>;
}

export interface ImageMedia extends MediaBase {
  readonly type: "image";
  /** Pixel width, if the provider sent it on the originating block. */
  readonly width?: number;
  /** Pixel height, if the provider sent it on the originating block. */
  readonly height?: number;
}

export interface VideoMedia extends MediaBase {
  readonly type: "video";
}

export interface FileMedia extends MediaBase {
  readonly type: "file";
  /** File name hint, if the provider sent it on the originating block. */
  readonly filename?: string;
}

export type AnyMediaHandle = AudioMedia | ImageMedia | VideoMedia | FileMedia;

function base64ToBytes(b64: string): Uint8Array {
  // atob is standard in all modern browsers and Node >= 16. Works on
  // standard base64 only (no `-`/`_` URL-safe variants; the protocol
  // uses standard base64).
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function concatBytes(parts: Uint8Array[], totalLength: number): Uint8Array {
  const out = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/**
 * Concrete handle implementation shared by all four media types.
 *
 * One instance per `(messageId, blockType)` pair created by the
 * assembler on first matching `content-block-start`.
 */
class MediaHandleImpl {
  readonly type: MediaBlockType;
  readonly messageId: string;
  readonly namespace: string[];
  readonly node: string | undefined;
  readonly id: string | undefined;

  mimeType: string | undefined;
  url: string | undefined;
  width?: number;
  height?: number;
  filename?: string;

  monotonic = true;
  error: MediaAssemblyError | undefined;

  // Byte accumulation --------------------------------------------------

  readonly #parts: Uint8Array[] = [];
  #totalBytes = 0;
  #partialSnapshot: Uint8Array = new Uint8Array(0);

  // Stream (lazy, idempotent getter) ----------------------------------
  //
  // First access creates the `ReadableStream` and wires it to future
  // chunks; subsequent accesses return the SAME reference. Consumers
  // that want to fan-out must call `.tee()` explicitly — the native
  // `ReadableStream.locked` flag prevents two concurrent readers.

  #stream: ReadableStream<Uint8Array> | undefined;
  #streamController: ReadableStreamDefaultController<Uint8Array> | undefined;

  // Blob / URL settlement ---------------------------------------------

  #blobResolve!: (value: Blob) => void;
  #blobReject!: (reason: unknown) => void;
  readonly #blobPromise: Promise<Blob>;

  #transcriptParts: string[] = [];
  #transcriptResolve!: (value: string | undefined) => void;
  #transcriptReject!: (reason: unknown) => void;
  readonly #transcriptPromise: Promise<string | undefined>;

  #cachedObjectURL: string | undefined;

  // URL-sourced mode ---------------------------------------------------

  #urlSourced = false;
  #urlFetchPromise: Promise<Uint8Array> | undefined;

  // Index tracking -----------------------------------------------------

  #lastIndex = -1;

  // Lifecycle flags ----------------------------------------------------

  #finished = false;
  #settled = false;

  // Injected dependencies ---------------------------------------------

  readonly #fetchImpl: typeof fetch;

  constructor(options: {
    type: MediaBlockType;
    messageId: string;
    namespace: string[];
    node: string | undefined;
    id: string | undefined;
    mimeType: string | undefined;
    url: string | undefined;
    fetch: typeof fetch;
  }) {
    this.type = options.type;
    this.messageId = options.messageId;
    this.namespace = options.namespace;
    this.node = options.node;
    this.id = options.id;
    this.mimeType = options.mimeType;
    this.url = options.url;
    this.#fetchImpl = options.fetch;

    this.#blobPromise = new Promise<Blob>((resolve, reject) => {
      this.#blobResolve = resolve;
      this.#blobReject = reject;
    });
    // Swallow rejections here so the async promise doesn't surface as
    // an unhandled rejection when callers never touch `.blob`. Any
    // consumer that does await it still observes the original reason.
    this.#blobPromise.catch(() => undefined);

    this.#transcriptPromise = new Promise<string | undefined>(
      (resolve, reject) => {
        this.#transcriptResolve = resolve;
        this.#transcriptReject = reject;
      }
    );
    this.#transcriptPromise.catch(() => undefined);
  }

  // ---------- Input side (driven by the assembler) ----------

  /** Track a block index for the monotonic-ordering diagnostic. */
  observeIndex(index: number): void {
    if (index !== this.#lastIndex + 1 && index !== this.#lastIndex) {
      this.monotonic = false;
    }
    if (index > this.#lastIndex) this.#lastIndex = index;
  }

  /** Absorb `mime_type` / per-type extras carried on an incoming block. */
  absorbBlock(block: ContentBlock): void {
    if (this.#urlSourced) return;
    // `Extensible` widens `block.type` from a literal to `string` in
    // the union, defeating TS's discriminated-union narrowing. Cast
    // after the runtime tag check.
    if (block.type === "audio") this.#absorbAudio(block as AudioContentBlock);
    else if (block.type === "image")
      this.#absorbImage(block as ImageContentBlock);
    else if (block.type === "video")
      this.#absorbVideo(block as VideoContentBlock);
    else if (block.type === "file") this.#absorbFile(block as FileContentBlock);
  }

  /** Record that the originating block arrived with `url` not `data`. */
  enterUrlMode(url: string): void {
    this.#urlSourced = true;
    this.url = url;
  }

  /** Push a fresh chunk of bytes into the handle. */
  pushBytes(bytes: Uint8Array): void {
    if (this.#finished || this.#settled) return;
    if (bytes.byteLength === 0) return;
    this.#parts.push(bytes);
    this.#totalBytes += bytes.byteLength;
    this.#partialSnapshot = concatBytes(this.#parts, this.#totalBytes);
    if (this.#streamController != null) {
      try {
        this.#streamController.enqueue(bytes);
      } catch {
        // Reader detached; ignore — `partialBytes`/`blob` still work.
      }
    }
  }

  /** Append a transcript fragment from an audio block. */
  pushTranscript(fragment: string): void {
    if (this.type !== "audio") return;
    if (this.#finished || this.#settled) return;
    if (fragment.length === 0) return;
    this.#transcriptParts.push(fragment);
  }

  /** Called on `message-finish`. Settles blob/transcript/stream. */
  finish(): void {
    if (this.#finished || this.#settled) return;
    this.#finished = true;
    this.#settled = true;
    // Cast: the lib types reject `Uint8Array<ArrayBufferLike>` because
    // `BlobPart` requires `Uint8Array<ArrayBuffer>` specifically. Our
    // accumulator is allocated with `new Uint8Array(len)`, so it is
    // backed by an `ArrayBuffer` (not `SharedArrayBuffer`).
    const blob = new Blob([this.#partialSnapshot as unknown as BlobPart], {
      type: this.mimeType ?? "",
    });
    this.#blobResolve(blob);
    this.#transcriptResolve(
      this.#transcriptParts.length === 0
        ? undefined
        : this.#transcriptParts.join("")
    );
    try {
      this.#streamController?.close();
    } catch {
      // Reader may have detached already.
    }
  }

  /** Propagate an error through blob/transcript/stream. */
  fail(
    kind: MediaAssemblyErrorKind,
    reason?: string,
    cause?: unknown
  ): MediaAssemblyError {
    if (this.#settled) {
      return (
        this.error ??
        new MediaAssemblyError(
          kind,
          this.messageId,
          this.#partialSnapshot,
          reason,
          { cause }
        )
      );
    }
    this.#settled = true;
    const err = new MediaAssemblyError(
      kind,
      this.messageId,
      this.#partialSnapshot,
      reason,
      { cause }
    );
    this.error = err;
    this.#blobReject(err);
    this.#transcriptReject(err);
    try {
      this.#streamController?.error(err);
    } catch {
      // Reader may have detached already.
    }
    return err;
  }

  // ---------- Public surface read by consumers ----------

  get partialBytes(): Uint8Array {
    return this.#partialSnapshot;
  }

  get blob(): Promise<Blob> {
    if (this.#urlSourced)
      return this.#fetchUrlSourced().then(
        (bytes) =>
          new Blob([bytes as unknown as BlobPart], {
            type: this.mimeType ?? "",
          })
      );
    return this.#blobPromise;
  }

  get transcript(): Promise<string | undefined> {
    return this.#transcriptPromise;
  }

  get objectURL(): Promise<string> {
    if (this.#cachedObjectURL != null) {
      const cached = this.#cachedObjectURL;
      return Promise.resolve(cached);
    }
    return this.blob.then((blob) => {
      // Race-safe: if revoke() fired before we got here, we cache the
      // freshly-created URL for the next reader.
      if (this.#cachedObjectURL != null) return this.#cachedObjectURL;
      const url = URL.createObjectURL(blob);
      this.#cachedObjectURL = url;
      return url;
    });
  }

  revoke(): void {
    const url = this.#cachedObjectURL;
    if (url == null) return;
    this.#cachedObjectURL = undefined;
    try {
      URL.revokeObjectURL(url);
    } catch {
      // URL.revokeObjectURL is side-effect-only; very unlikely to throw
      // but keep the handle usable if a polyfill misbehaves.
    }
  }

  get stream(): ReadableStream<Uint8Array> {
    if (this.#stream != null) return this.#stream;
    if (this.#urlSourced) return this.#buildUrlStream();
    return this.#buildInlineStream();
  }

  // ---------- Internals ----------

  #absorbAudio(block: AudioContentBlock): void {
    const mimeType =
      block.mime_type ?? (block as { mimeType?: string }).mimeType;
    if (this.mimeType == null && mimeType != null) this.mimeType = mimeType;
    if (block.transcript != null && block.transcript.length > 0) {
      this.pushTranscript(block.transcript);
    }
  }

  #absorbImage(block: ImageContentBlock): void {
    const mimeType =
      block.mime_type ?? (block as { mimeType?: string }).mimeType;
    if (this.mimeType == null && mimeType != null) this.mimeType = mimeType;
    if (this.width == null && block.width != null) this.width = block.width;
    if (this.height == null && block.height != null) this.height = block.height;
  }

  #absorbVideo(block: VideoContentBlock): void {
    const mimeType =
      block.mime_type ?? (block as { mimeType?: string }).mimeType;
    if (this.mimeType == null && mimeType != null) this.mimeType = mimeType;
  }

  #absorbFile(block: FileContentBlock): void {
    const mimeType =
      block.mime_type ?? (block as { mimeType?: string }).mimeType;
    if (this.mimeType == null && mimeType != null) this.mimeType = mimeType;
    if (this.filename == null && block.filename != null)
      this.filename = block.filename;
  }

  #buildInlineStream(): ReadableStream<Uint8Array> {
    const seed = this.#partialSnapshot;
    const alreadyFinished = this.#finished;
    const alreadyErrored = this.error;

    this.#stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.#streamController = controller;
        if (seed.byteLength > 0) controller.enqueue(seed);
        if (alreadyErrored != null) {
          controller.error(alreadyErrored);
          return;
        }
        if (alreadyFinished) {
          controller.close();
        }
      },
      cancel: () => {
        this.#streamController = undefined;
      },
    });
    return this.#stream;
  }

  #buildUrlStream(): ReadableStream<Uint8Array> {
    // For URL-sourced blocks, we pipe the fetch response body directly
    // through. `partialBytes` / `blob` share the same buffered bytes via
    // #fetchUrlSourced().
    const urlSourceFetch = this.#startUrlFetch();
    this.#stream = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        try {
          const response = await urlSourceFetch;
          if (response.body == null) {
            const bytes = new Uint8Array(await response.arrayBuffer());
            if (bytes.byteLength > 0) controller.enqueue(bytes);
            controller.close();
            return;
          }
          const reader = response.body.getReader();
          // oxlint-disable-next-line no-constant-condition
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value != null) controller.enqueue(value);
          }
          controller.close();
        } catch (err) {
          controller.error(
            this.fail("fetch-failed", (err as Error)?.message, err)
          );
        }
      },
      cancel: () => {
        this.#streamController = undefined;
      },
    });
    return this.#stream;
  }

  /** Memoised fetch for URL-sourced blocks — returns one `Response`. */
  #startUrlFetch(): Promise<Response> {
    const url = this.url!;
    return this.#fetchImpl(url).then((response) => {
      if (!response.ok) {
        throw new Error(
          `fetch(${url}) failed: ${response.status} ${response.statusText}`
        );
      }
      return response;
    });
  }

  /** Fetch + buffer for URL-sourced `blob` access. Memoised. */
  #fetchUrlSourced(): Promise<Uint8Array> {
    if (this.#urlFetchPromise != null) return this.#urlFetchPromise;
    this.#urlFetchPromise = (async () => {
      try {
        const response = await this.#startUrlFetch();
        const bytes = new Uint8Array(await response.arrayBuffer());
        this.#parts.length = 0;
        this.#parts.push(bytes);
        this.#totalBytes = bytes.byteLength;
        this.#partialSnapshot = bytes;
        this.#finished = true;
        this.#settled = true;
        return bytes;
      } catch (err) {
        throw this.fail("fetch-failed", (err as Error)?.message, err);
      }
    })();
    return this.#urlFetchPromise;
  }
}

/**
 * Dispatch callbacks receive a freshly-started handle on its first
 * matching `content-block-start`. Exactly one callback fires per
 * `(messageId, blockType)` pair.
 */
export interface MediaAssemblerCallbacks {
  onAudio?: (media: AudioMedia) => void;
  onImage?: (media: ImageMedia) => void;
  onVideo?: (media: VideoMedia) => void;
  onFile?: (media: FileMedia) => void;
  /**
   * Invoked for every type; receives the same handle as the typed
   * callback. Useful for writing one "all media" consumer without
   * registering four type-specific callbacks.
   */
  onMedia?: (media: AnyMediaHandle) => void;
}

export interface MediaAssemblerOptions extends MediaAssemblerCallbacks {
  /**
   * Injected `fetch` used for URL-sourced blocks. Defaults to the
   * global `fetch`. Throws on first URL access if neither is present.
   */
  fetch?: typeof fetch;
}

/**
 * Incrementally folds `messages` events into typed media handles
 * (audio / image / video / file) that buffer bytes, expose a
 * {@link Blob}, and lazily mint an object URL for direct use in
 * `<audio>` / `<img>` / `<video>` tags.
 *
 * Semantics pinned during design:
 *  - One handle per `(messageId, blockType)` pair. Mixed-type messages
 *    surface on multiple iterables with the same `messageId`.
 *  - Handle yielded on the **first matching `content-block-start`** —
 *    messages with no matching blocks never yield an item (filters
 *    `lc_run--` LangChain terminator noise automatically).
 *  - Byte extraction: every `content-block-start` /
 *    `content-block-delta` with a `data` field decodes base64 and
 *    pushes into the accumulator. `content-block-finish` is a sync
 *    point.
 *  - URL-sourced blocks: if the initial block carries `url`, the
 *    handle enters URL mode — `blob`/`stream`/`objectURL` lazy-fetch
 *    on first access, subsequent data/url deltas are ignored.
 *  - Fail loud: `message-error`, stream closure before finish, and
 *    fetch failures all populate `handle.error`, reject `blob` /
 *    `transcript` / `objectURL`, and error the stream.
 *  - Diagnostic only: `handle.monotonic` flips false if block indices
 *    arrive out of order (protocol guarantees in-order within a
 *    subscription, so `false` indicates an upstream bug).
 */
/**
 * Per-`(namespace, node)` bookkeeping for the active message the
 * assembler is currently folding.
 *
 * Protocol v2 only carries `id` on `message-start`; all
 * subsequent `content-block-*` / `message-finish` / `error` events
 * address the active message by position (same namespace + node). The
 * assembler therefore pins a message entry when `message-start`
 * arrives and resolves follow-ups by looking up `(namespace, node)`.
 */
interface ActiveMessage {
  /** `id` from `message-start`, or empty string when synthesized. */
  messageId: string;
  /** `${messageId}::${mediaType}::${index}` keys currently active under this message. */
  keys: Set<string>;
  /** Content-block index → active media key. */
  indexKeys: Map<number, string>;
}

export class MediaAssembler {
  readonly #callbacks: MediaAssemblerCallbacks;
  readonly #fetch: typeof fetch;
  // Keyed by `${messageId}::${type}::${blockIndex}`.
  readonly #active = new Map<string, MediaHandleImpl>();
  // Maps `${namespace.join("/")}::${node ?? ""}` → active message. One
  // entry per in-flight logical message; replaced on each
  // `message-start`, removed on `message-finish` / `error`.
  readonly #activeByNamespaceNode = new Map<string, ActiveMessage>();
  // Monotonically increasing counter used to mint stable synthetic
  // ids when a `content-block-*` arrives before any `message-start`
  // (e.g. late-attaching subscribers that missed the message-start).
  #syntheticCounter = 0;

  constructor(options: MediaAssemblerOptions = {}) {
    this.#callbacks = options;
    if (options.fetch != null) {
      this.#fetch = options.fetch;
    } else if (typeof fetch === "function") {
      this.#fetch = fetch;
    } else {
      // Throw lazily on URL access rather than construction, so
      // inline-only flows in Node without a global fetch still work.
      this.#fetch = () => {
        throw new Error(
          "MediaAssembler: no fetch implementation available. Pass `fetch` in options."
        );
      };
    }
  }

  /**
   * Fold a single `messages` event. Non-media blocks and
   * informational events (e.g. `content-block-finish`) are no-ops.
   */
  consume(event: MessagesEvent): void {
    const data = event.params.data;
    const namespace = event.params.namespace;
    const node = event.params.node;
    const nsNodeKey = `${namespace.join("/")}::${node ?? ""}`;

    if (data.event === "message-start") {
      // A new `message-start` may arrive before a prior message on
      // the same `(namespace, node)` emitted `message-finish` (the
      // protocol permits trimmed replays on late subscribers). Flush
      // any in-flight handles under that slot before rebinding.
      this.#flushSlot(nsNodeKey, "finish");
      this.#activeByNamespaceNode.set(nsNodeKey, {
        messageId: data.id ?? "",
        keys: new Set(),
        indexKeys: new Map(),
      });
      return;
    }

    if (data.event === "message-finish") {
      this.#flushSlot(nsNodeKey, "finish");
      this.#activeByNamespaceNode.delete(nsNodeKey);
      return;
    }

    if (data.event === "error") {
      this.#flushSlot(
        nsNodeKey,
        "error",
        (data as { message?: string }).message
      );
      this.#activeByNamespaceNode.delete(nsNodeKey);
      return;
    }

    if (
      data.event !== "content-block-start" &&
      data.event !== "content-block-delta" &&
      data.event !== "content-block-finish"
    ) {
      return;
    }

    const block = (data as { content?: ContentBlock; index?: number }).content;
    const blockIndex = (data as { index?: number }).index ?? 0;

    // Resolve the active message for this `(namespace, node)`. If the
    // subscriber attached mid-message and missed `message-start`,
    // synthesize one so downstream blocks still produce a handle.
    let active = this.#activeByNamespaceNode.get(nsNodeKey);
    if (active == null) {
      active = {
        messageId: `__synthetic_${++this.#syntheticCounter}`,
        keys: new Set(),
        indexKeys: new Map(),
      };
      this.#activeByNamespaceNode.set(nsNodeKey, active);
    }

    if (block == null && data.event === "content-block-delta") {
      const delta = (data as { delta?: unknown }).delta;
      const deltaKey = active.indexKeys.get(blockIndex);
      const deltaHandle =
        deltaKey != null ? this.#active.get(deltaKey) : undefined;
      if (delta == null || typeof delta !== "object") {
        return;
      }

      const record = delta as Record<string, unknown>;

      if (deltaHandle == null) {
        if (
          record.type !== "block-delta" ||
          record.fields == null ||
          typeof record.fields !== "object"
        ) {
          return;
        }

        const fields = record.fields as ContentBlock;
        if (!MEDIA_BLOCK_TYPES.has(fields.type)) {
          return;
        }

        this.#consumeMediaBlock({
          active,
          block: fields,
          blockIndex,
          dataEvent: data.event,
          namespace,
          node,
          terminal: false,
          createIfMissing: true,
        });
        return;
      }

      deltaHandle.observeIndex(blockIndex);
      if (record.type === "data-delta" && typeof record.data === "string") {
        try {
          deltaHandle.pushBytes(base64ToBytes(record.data));
        } catch (err) {
          deltaHandle.fail("message-error", "invalid base64 on delta", err);
        }
        return;
      }

      if (
        record.type === "block-delta" &&
        record.fields != null &&
        typeof record.fields === "object"
      ) {
        const fields = record.fields as
          | AudioContentBlock
          | ImageContentBlock
          | VideoContentBlock
          | FileContentBlock;
        deltaHandle.absorbBlock(fields);
        if (!deltaHandle.error && fields.data != null) {
          try {
            deltaHandle.pushBytes(base64ToBytes(fields.data));
          } catch (err) {
            deltaHandle.fail("message-error", "invalid base64 on delta", err);
          }
        }
      }
      return;
    }

    if (block == null) return;
    const blockType = block.type;
    if (!MEDIA_BLOCK_TYPES.has(blockType)) return;

    this.#consumeMediaBlock({
      active,
      block: block as ContentBlock,
      blockIndex,
      dataEvent: data.event,
      namespace,
      node,
      terminal: data.event === "content-block-finish",
      createIfMissing:
        data.event === "content-block-start" ||
        data.event === "content-block-finish",
    });
  }

  #consumeMediaBlock({
    active,
    block,
    blockIndex,
    dataEvent,
    namespace,
    node,
    terminal,
    createIfMissing,
  }: {
    active: ActiveMessage;
    block: ContentBlock;
    blockIndex: number;
    dataEvent: string;
    namespace: string[];
    node: string | undefined;
    terminal: boolean;
    createIfMissing: boolean;
  }): void {
    const blockType = block.type;
    if (!MEDIA_BLOCK_TYPES.has(blockType)) return;

    const mediaType = blockType as MediaBlockType;
    const key = `${active.messageId}::${mediaType}::${blockIndex}`;
    let handle = this.#active.get(key);
    const isStart = dataEvent === "content-block-start";

    if (handle == null) {
      const isTerminalBlock = terminal;
      if (!isStart && !isTerminalBlock && !createIfMissing) {
        return;
      }
      const mediaBlock = block as
        | AudioContentBlock
        | ImageContentBlock
        | VideoContentBlock
        | FileContentBlock;
      handle = new MediaHandleImpl({
        type: mediaType,
        messageId: active.messageId,
        namespace: [...namespace],
        node,
        id: (mediaBlock as { id?: string }).id,
        mimeType:
          mediaBlock.mime_type ??
          (mediaBlock as { mimeType?: string }).mimeType,
        url:
          mediaBlock.url != null && mediaBlock.data == null
            ? mediaBlock.url
            : undefined,
        fetch: this.#fetch,
      });
      if (mediaBlock.url != null && mediaBlock.data == null) {
        handle.enterUrlMode(mediaBlock.url);
      }
      handle.observeIndex(blockIndex);
      handle.absorbBlock(block);
      if (mediaBlock.data != null) {
        try {
          handle.pushBytes(base64ToBytes(mediaBlock.data));
        } catch (err) {
          handle.fail("message-error", "invalid base64 on initial block", err);
        }
      }
      this.#active.set(key, handle);
      active.keys.add(key);
      active.indexKeys.set(blockIndex, key);
      this.#emit(handle);
      if (isTerminalBlock) {
        handle.finish();
        this.#active.delete(key);
        active.keys.delete(key);
        active.indexKeys.delete(blockIndex);
      }
      return;
    }

    // Subsequent event on an existing handle.
    // - `content-block-finish` is a sync point: skip to avoid
    //   double-counting bytes when the server echoes the full block
    //   on both start and finish (typical for atomic, non-delta
    //   blocks such as whole audio frames or single-shot images).
    // A late subscriber may miss `content-block-start`; in that case a
    // terminal block with full content is handled above by creating and
    // immediately settling a one-block handle.
    if (terminal) return;

    const mediaBlock = block as
      | AudioContentBlock
      | ImageContentBlock
      | VideoContentBlock
      | FileContentBlock;
    handle.observeIndex(blockIndex);
    handle.absorbBlock(block);
    if (!handle.error && mediaBlock.data != null) {
      try {
        handle.pushBytes(base64ToBytes(mediaBlock.data));
      } catch (err) {
        handle.fail("message-error", "invalid base64 on delta", err);
      }
    }
  }

  /**
   * Finish or fail every media handle currently active under the
   * given `(namespace, node)` slot and clear its bookkeeping. Called
   * on `message-finish`, `error`, and when a new `message-start`
   * rebinds a still-open slot.
   */
  #flushSlot(
    nsNodeKey: string,
    mode: "finish" | "error",
    errorMessage?: string
  ): void {
    const active = this.#activeByNamespaceNode.get(nsNodeKey);
    if (active == null) return;
    for (const key of active.keys) {
      const handle = this.#active.get(key);
      if (handle != null) {
        if (mode === "finish") handle.finish();
        else handle.fail("message-error", errorMessage);
      }
      this.#active.delete(key);
    }
    active.keys.clear();
    active.indexKeys.clear();
  }

  /**
   * Abort all outstanding handles with a `stream-closed` error.
   * Called when the upstream event source terminates before the
   * messages it was assembling had a chance to finish.
   */
  close(): void {
    for (const handle of this.#active.values()) {
      handle.fail("stream-closed", "upstream event stream closed");
    }
    this.#active.clear();
    this.#activeByNamespaceNode.clear();
  }

  #emit(handle: MediaHandleImpl): void {
    switch (handle.type) {
      case "audio":
        this.#callbacks.onAudio?.(handle as unknown as AudioMedia);
        break;
      case "image":
        this.#callbacks.onImage?.(handle as unknown as ImageMedia);
        break;
      case "video":
        this.#callbacks.onVideo?.(handle as unknown as VideoMedia);
        break;
      case "file":
        this.#callbacks.onFile?.(handle as unknown as FileMedia);
        break;
    }
    this.#callbacks.onMedia?.(handle as unknown as AnyMediaHandle);
  }
}

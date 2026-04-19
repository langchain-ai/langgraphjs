Taking 15b as implicitly accepted (it's the only coherent reading). Enough grilling — here is the full proposal.

---

# Proposal: First-class media handles in `@langchain/langgraph-sdk`

## Goals

Replace the hand-rolled reassembly loop in `examples/streaming/src/api/multimodal_stream.ts` (and its WebSocket twin) with a first-class, browser-native SDK API. Callers should be able to wire SDK output directly into `<audio>`, `<img>`, `<video>`, or `<a download>` tags without base64 decoding, Buffer construction, or hash-based reassembly.

## Scope

- Four protocol block types per `protocol.cddl`: `AudioBlock`, `ImageBlock`, `VideoBlock`, `FileBlock`.
- Delivered in both modes: inline (`data: <base64>`) and remote (`url: <string>`).
- Surfaces: `ThreadStream`, `SubgraphHandle`, `SubagentHandle` (SDK), and `@langchain/react` `useStreamExperimental` selector hooks (React).
- **React changes are limited to `libs/sdk-react/src/stream-experimental/`.** The other React binding trees are out of scope.

## Public API — SDK core

### New iterables on `ThreadStream`, `SubgraphHandle`, `SubagentHandle`

```ts
class ThreadStream<…> {
  get audio(): AsyncIterable<AudioMedia>;
  get images(): AsyncIterable<ImageMedia>;
  get video(): AsyncIterable<VideoMedia>;
  get files(): AsyncIterable<FileMedia>;
  // existing messages / values / toolCalls / subagents / subgraphs unchanged
}

class SubgraphHandle {
  get audio(): AsyncIterable<AudioMedia>;
  get images(): AsyncIterable<ImageMedia>;
  get video(): AsyncIterable<VideoMedia>;
  get files(): AsyncIterable<FileMedia>;
}

class SubagentHandle {
  // same four getters, namespace-scoped like messages/toolCalls
}
```

Semantics (pinned in the grill):

- **One item per message per type.** A message containing N audio blocks + 1 image block yields one `AudioMedia` on `thread.audio` and one `ImageMedia` on `thread.images` with the same `messageId`.
- **Yielded on first matching `content-block-start`.** Messages with zero blocks of a given type never appear on that iterable (filters out `lc_run--` terminator noise automatically).
- **Root iterables are all-namespaces** (match `thread.messages`); subgraph/subagent iterables are namespace-filtered.
- **Iterable only.** No `PromiseLike`, no `.collect()` (match `thread.messages`).
- **Late attachers see full replay** via `MultiCursorBuffer`, including catch-up enqueue on `stream`.

### Media handle shapes

```ts
interface MediaBase {
  readonly messageId: string;
  readonly namespace: string[];
  readonly node?: string;
  readonly id?: string;                          // block.id, if provider sent one
  readonly mimeType?: string;
  readonly url?: string;                         // present iff block had url

  /** Live byte stream. Single-consumer. Lazy — not materialised unless accessed. */
  readonly stream: ReadableStream<Uint8Array>;

  /** Resolves on message-finish with the concatenated Blob. */
  readonly blob: Promise<Blob>;

  /**
   * Lazy + cached URL.createObjectURL over `blob`. Revoke with `revoke()`;
   * next access creates a fresh one. Auto-revoked on `thread.close()`
   * as a safety net.
   */
  readonly objectURL: Promise<string>;

  /** Live view of accumulated bytes. Useful for recovery after an error. */
  readonly partialBytes: Uint8Array;

  /** Set iff the handle settled in an error state. Otherwise undefined. */
  readonly error?: MediaAssemblyError;

  /** Diagnostic: false if block indices arrived out of order. */
  readonly monotonic: boolean;

  revoke(): void;
}

interface AudioMedia extends MediaBase {
  readonly type: "audio";
  /** Concatenated transcript across all this message's audio blocks. */
  readonly transcript: Promise<string | undefined>;
}

interface ImageMedia extends MediaBase {
  readonly type: "image";
  readonly width?: number;    // only if block carried it
  readonly height?: number;
}

interface VideoMedia extends MediaBase {
  readonly type: "video";
}

interface FileMedia extends MediaBase {
  readonly type: "file";
  readonly filename?: string;
}

class MediaAssemblyError extends Error {
  readonly kind: "message-error" | "stream-closed" | "fetch-failed";
  readonly messageId: string;
  readonly cause?: unknown;
  readonly partialBytes: Uint8Array;
}
```

### New constructor option

```ts
interface ThreadStreamOptions {
  // … existing …
  fetch?: typeof fetch;   // injected into MediaAssembler for URL-sourced blocks
}
```

### Additional exports

```ts
// @langchain/langgraph-sdk
export { MediaAssembler };
export type { AudioMedia, ImageMedia, VideoMedia, FileMedia, MediaBase, MediaAssemblyError };
```

`MediaAssembler` is exported so power users can plug their own event pipeline into it (symmetric with the existing `MessageAssembler` / `ToolCallAssembler` exports).

## Public API — React (`libs/sdk-react/src/stream-experimental/` only)

```ts
// Primary: typed array hooks, one per media kind
function useAudio (stream, target?): AudioMedia[];
function useImages(stream, target?): ImageMedia[];
function useVideo (stream, target?): VideoMedia[];
function useFiles (stream, target?): FileMedia[];

// Convenience: resolve an object URL, auto-revoke on unmount
function useMediaURL(media: MediaBase | undefined): string | undefined;
```

Typical call sites:

```tsx
function TTSReply({ stream }: { stream: UseStreamExperimentalReturn<…, …> }) {
  const audio = useAudio(stream);
  return (
    <>
      {audio.map((a) => <AudioTurn key={a.messageId} audio={a} />)}
    </>
  );
}

function AudioTurn({ audio }: { audio: AudioMedia }) {
  const src = useMediaURL(audio);
  return src ? <audio src={src} controls /> : null;
}

function GeneratedImages({ stream, subagent }) {
  const images = useImages(stream, subagent);
  return images.map((img) => <ImgTile key={img.messageId} image={img} />);
}

function ImgTile({ image }: { image: ImageMedia }) {
  const src = useMediaURL(image);
  return src ? <img src={src} width={image.width} height={image.height} /> : null;
}
```

Wired through `ChannelRegistry.acquire` with four new `kind`s (`audio`, `images`, `video`, `files`), each running a `MediaAssembler` reducer filtering to its own block type. Ref-counting, thread-swap, and namespace scoping all fall out of the existing registry.

## Implementation

### `libs/sdk/src/client/stream/media.ts` (new)

- `MediaAssembler` class analogous to `MessageAssembler`.
  - Input: `MessagesEvent` stream (same wire channel).
  - Keyed by `(messageId, blockType)` rather than just `messageId` — one assembly per type per message.
  - `content-block-start` / `content-block-delta` → base64-decode `data` → push `Uint8Array` into the type's accumulator; if `stream` is materialised, enqueue to it; update `partialBytes`.
  - If the initial block carried `url`, enter URL-sourced mode: lazy `fetch(url)` on first `.stream`/`.blob`/`.objectURL` access; subsequent data/url deltas to the same block are ignored.
  - `content-block-finish` → mark that index closed.
  - `message-finish` → settle `blob`, `transcript`, `objectURL`, close `stream`.
  - `message-error` / transport abort → propagate `MediaAssemblyError` through `stream`, reject `blob`/`objectURL`, populate `error` + `partialBytes`.
- `MediaHandle` implementation for each of the four types, sharing a `MediaHandleBase` that handles lazy stream materialisation, `URL.createObjectURL` caching, and `revoke()`.

### `libs/sdk/src/client/stream/index.ts` (modified)

- Add `#mediaDispatcherStarted` + `#mediaEvents` backfill + per-type listener arrays + per-type `MultiCursorBuffer`s + per-type getters (`audio`, `images`, `video`, `files`).
- `#ensureMediaDispatcher()` opens **one** `["messages", ...lifecycleChannels()]` subscription and fans into the four buffers — identical pattern to `#ensureExtensionsDispatcher`.
- On `thread.close()`: iterate every handle in every buffer and call `revoke()` as safety net.
- Plumb `options.fetch` into the dispatcher so URL-sourced blocks honour auth injection.

### `libs/sdk/src/client/stream/handles/subgraphs.ts`, `handles/subagents.ts` (modified)

- Identical getters, identical dispatcher pattern, namespace-scoped (`namespaces: [this.namespace]`).

### `libs/sdk/src/stream-experimental/projections/media.ts` (new)

- Four projection factories (`audioProjection`, `imagesProjection`, `videoProjection`, `filesProjection`), each returning a reducer that folds a `MessagesEvent` stream into `MediaType[]` for the `ChannelRegistry`-backed store.
- Share the same `MediaAssembler` under the hood; each projection filters to its type.

### `libs/sdk-react/src/stream-experimental/selectors.ts` (modified)

- Add `useAudio`, `useImages`, `useVideo`, `useFiles` — 4-line wrappers over `useProjection` + the matching projection factory.

### `libs/sdk-react/src/stream-experimental/use-media-url.ts` (new)

```ts
export function useMediaURL(media: MediaBase | undefined): string | undefined {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!media) { setUrl(undefined); return; }
    let cancelled = false;
    media.objectURL.then((u) => { if (!cancelled) setUrl(u); }, () => {/* error surfaced via media.error */});
    return () => {
      cancelled = true;
      media.revoke();   // frees the objectURL slot
    };
  }, [media]);
  return url;
}
```

Handles unmount-during-fetch, target-change, and error cases without leaking object URLs.

### `libs/sdk-react/src/stream-experimental/index.ts` (modified)

- Re-export the four new hooks + `useMediaURL`.
- Re-export `AudioMedia`, `ImageMedia`, `VideoMedia`, `FileMedia`, `MediaBase`, `MediaAssemblyError` from `@langchain/langgraph-sdk/stream`.

## Example migration

`examples/streaming/src/api/multimodal_stream.ts` goes from 194 lines of manual assembly to roughly:

```ts
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@langchain/langgraph-sdk";
import { apiUrl, requireServer } from "./_shared.js";

async function main() {
  await requireServer(apiUrl());
  const client = new Client({ apiUrl: apiUrl() });
  const thread = client.threads.stream({ assistantId: "agent_multimodal_stream" });

  await thread.run.input({
    input: { messages: [{ role: "user", content: "make-me-something" }] },
  });

  for await (const audio of thread.audio) {
    const bytes = new Uint8Array(await (await audio.blob).arrayBuffer());
    writeFileSync(join(tmpdir(), "multimodal-audio.wav"), bytes);
    console.log("audio sha:", createHash("sha256").update(bytes).digest("hex"));
  }

  for await (const image of thread.images) {
    const bytes = new Uint8Array(await (await image.blob).arrayBuffer());
    writeFileSync(join(tmpdir(), "multimodal-image.png"), bytes);
    console.log("image sha:", createHash("sha256").update(bytes).digest("hex"));
  }

  await thread.close();
}

await main();
```

WebSocket variant is identical modulo the `transport: "websocket"` option.

## Summary of decisions locked during the grill

| # | Decision | Resolution |
|---|---|---|
| 1 | Playback semantics | Blob + object URL as primary; `ReadableStream<Uint8Array>` for MSE-style callers |
| 2 | API surface | Per-type iterables (`audio`/`images`/`video`/`files`); no union `media` iterable |
| 3 | Granularity | One item per message per type; yielded on first matching `content-block-start` |
| 4 | `url` vs `data` | Lazy fetch-on-access for URL-sourced; injectable `fetch` |
| 5a | Namespaces | Root = all-namespaces; subgraph/subagent = scoped — match `thread.messages` |
| 5b | Empty / artifact messages | Don't yield unless ≥ 1 matching block arrived |
| 6 | Object URL lifecycle | Caller-owns; `media.revoke()` convenience; `thread.close()` safety-net revoke; `objectURL: Promise<string>` |
| 7 | Errors | Fail loud uniformly; expose `error` + `partialBytes` for recovery |
| 8 | Per-type fields | Protocol-carried only; no lazy decoders; `transcript` is `Promise<string \| undefined>` |
| 9 | Backpressure | Lazy-materialised, unbounded, single-consumer `ReadableStream`; `.tee()` for fan-out |
| 10 | `PromiseLike` on iterable | No — iterable only, match `thread.messages` |
| 11 | Byte extraction | Event-level (start + delta), trust wire order, `monotonic: boolean` diagnostic |
| 12 | Subscription sharing | One shared media-dispatcher subscription per handle (root / subgraph / subagent) |
| 13 | Late attach | Full replay including `stream` catch-up enqueue |
| 14 | React | `useAudio` / `useImages` / `useVideo` / `useFiles` return handles; `useMediaURL` convenience |
| 15a | Naming | `audio`, `images`, `video`, `files` (natural English, inconsistent but readable) |
| 15b | Mixed-type messages | One item per message **per type**; same `messageId` surfaces on multiple iterables |

## Follow-ups not in scope

- **WebAudio / PCM decoding.** Progressive sample-accurate playback via `AudioContext` is a separate layer on top of `media.stream`.
- **MSE wiring helper.** A `useMediaSource(media): MediaSource | undefined` hook that pipes `media.stream` into a `SourceBuffer` for `<audio>` progressive playback. Requires container-format sniffing; deserves its own design pass.
- **Non-standard blocks.** `NonStandardBlock` (CDDL line 231) is out of scope for these iterables.
- **`ThreadStream.run.input` double-subscription cleanup** (already tracked in `useStreamExperimental.md` §10).

Ready to implement on your signal.
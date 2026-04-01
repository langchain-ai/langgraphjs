# Streaming media

Models that emit `audio`, `image`, `video`, or `file` content blocks
produce **media handles** on `ThreadStream`. Each handle lets you
stream raw bytes as they arrive, peek at a live `partialBytes`
snapshot, or wait for a final `Blob` / `objectURL` on completion.

```ts
thread.audio;  // AsyncIterable<AudioMedia>
thread.images; // AsyncIterable<ImageMedia>
thread.video;  // AsyncIterable<VideoMedia>
thread.files;  // AsyncIterable<FileMedia>
```

All four are fed by a single shared `messages`-channel subscription —
there is no fan-out cost for the types you don't consume.

## One handle per `(messageId, blockType)`

The assembler yields one handle per message containing at least one
block of that type. Messages with no media blocks are skipped. The
first matching `content-block-start` creates the handle; subsequent
deltas / starts for the same type feed the same handle.

## The `MediaBase` surface

```ts
interface MediaBase {
  readonly messageId: string;
  readonly namespace: string[];
  readonly node?: string;
  readonly id?: string;
  readonly mimeType?: string;
  readonly url?: string;

  readonly stream: ReadableStream<Uint8Array>;
  readonly blob: Promise<Blob>;
  readonly objectURL: Promise<string>;
  readonly partialBytes: Uint8Array;

  readonly error?: MediaAssemblyError;
  readonly monotonic: boolean;

  revoke(): void;
}
```

Per-type handles add a few extras:

| Type         | Extra fields                                                       |
| ------------ | ------------------------------------------------------------------ |
| `AudioMedia` | `transcript: Promise<string \| undefined>`                         |
| `ImageMedia` | `width?: number`, `height?: number`                                |
| `VideoMedia` | —                                                                  |
| `FileMedia`  | `filename?: string`                                                |

## Rendering audio in a browser

```ts
for await (const audio of thread.audio) {
  const url = await audio.objectURL;
  const el = new Audio(url);
  el.play();

  const transcript = await audio.transcript;
  if (transcript) console.log("transcript:", transcript);
}
```

## Streaming bytes as they arrive

`media.stream` is a lazy, single-consumer `ReadableStream<Uint8Array>`.
First access seeds the stream with bytes accumulated so far, then
wires it to future chunks:

```ts
for await (const audio of thread.audio) {
  const reader = audio.stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    pipeChunkToPlayer(value);
  }
}
```

Concurrent readers are not supported — use
`audio.stream.tee()` when you need fan-out.

### URL-sourced blocks

If the originating block carried a `url` instead of inline `data`, the
handle lazily fetches the URL on first access to `stream`, `blob`, or
`objectURL`. The injected `fetch` (from
`threads.stream({ fetch })`) is used — useful for auth proxies and
CORS workarounds.

## Snapshot access

`partialBytes` is a live `Uint8Array` view of everything received so
far. Ideal for progressive rendering (e.g. drawing an image as it
loads):

```ts
for await (const image of thread.images) {
  renderPartial(image.partialBytes);
  const final = await image.blob;
  renderFinal(final);
}
```

## Errors

Media handles can fail in three ways:

| Kind             | When                                                                |
| ---------------- | ------------------------------------------------------------------- |
| `message-error`  | The parent message emitted an `error` event before finish.          |
| `stream-closed`  | Transport dropped before `message-finish` arrived.                  |
| `fetch-failed`   | URL-sourced block and the lazy `fetch()` rejected.                  |

On failure:

- `media.stream` errors the next reader.
- `media.blob` and `media.objectURL` reject with
  `MediaAssemblyError`.
- `media.error` is populated synchronously with the typed error
  (including `partialBytes` for diagnostics).

```ts
for await (const file of thread.files) {
  try {
    const blob = await file.blob;
    saveLocal(blob);
  } catch (err) {
    if (err instanceof MediaAssemblyError) {
      console.warn(`${err.kind}:`, err.partialBytes.byteLength, "bytes buffered");
    }
  }
}
```

## Cleaning up object URLs

Calling `media.objectURL` caches a `URL.createObjectURL(blob)` — call
`media.revoke()` to release the slot, and the next access creates a
fresh URL.

`thread.close()` automatically revokes any URLs the SDK minted as a
safety net, but long-lived UIs should call `revoke()` explicitly when
a media element is unmounted.

## Integration tip: fetch overrides

Pass `fetch` when you need the URL fetch path to go through a proxy
or a test mock:

```ts
const thread = client.threads.stream({
  assistantId: "media-agent",
  fetch: authedFetch,
});
```

## Selector composables

Selector composables return a small handle shaped `{ get current(): T }`. Read `.current` in templates / `$derived` for reactive access.

Composables that take a `target` accept a discovery snapshot (`stream.subagents.get(name)`), an explicit `{ namespace }`, or a raw `string[]`. Pass a getter (`() => target`) to make the binding reactive.

Each selector opens a **ref-counted** subscription when the first component mounts it and releases it when the last consumer unmounts. Components that don't render a given subagent or media stream pay nothing for its wire traffic.

| Composable                                        | Returns                                                                  | Purpose                                                  |
| ------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------- |
| `useMessages(stream, target?)`                    | `{ current: BaseMessage[] }`                                             | Scoped messages. At root delegates to `stream.messages`. |
| `useToolCalls(stream, target?)`                   | `{ current: AssembledToolCall[] }`                                       | Scoped tool calls.                                       |
| `useValues(stream, target?, options?)`            | `{ current: StateType }` (root) / `{ current: T \| undefined }` (scoped) | Scoped state values.                                     |
| `useExtension(stream, name, target?)`             | `{ current: T \| undefined }`                                            | Latest payload of a `custom:<name>` stream extension.    |
| `useChannel(stream, channels, target?, options?)` | `{ current: Event[] }`                                                   | Raw-protocol event stream (bounded buffer, all runs).    |
| `useChannelEffect(stream, channels, options)`     | `void`                                                                   | Per-event side-effect callback (analytics, logging).     |
| `useMessageMetadata(stream, messageId)`           | `{ current: MessageMetadata \| undefined }`                              | Per-message metadata (`parentCheckpointId`).             |
| `useSubmissionQueue(stream)`                      | `{ entries, size, cancel, clear }`                                       | Server-side [submission queue](./submission-queue.md).   |
| `useAudio(stream, target?)`                       | `{ current: AudioMedia[] }`                                              | Audio attachments in the namespace.                      |
| `useImages(stream, target?)`                      | `{ current: ImageMedia[] }`                                              | Image attachments.                                       |
| `useVideo(stream, target?)`                       | `{ current: VideoMedia[] }`                                              | Video attachments.                                       |
| `useFiles(stream, target?)`                       | `{ current: FileMedia[] }`                                               | File attachments.                                        |

See [Media](./media.md) for `useMediaURL`, `useAudioPlayer`, and `useVideoPlayer`.

---

## Example: per-subagent views

```svelte
<script lang="ts">
  import { useStream, useMessages, useToolCalls } from "@langchain/svelte";
  const stream = useStream({ assistantId: "agent", apiUrl: "http://localhost:2024" });
</script>

{#each [...stream.subagents.values()] as sub (sub.namespace.join("/"))}
  {@const msgs = useMessages(stream, sub)}
  {@const calls = useToolCalls(stream, sub)}

  <section>
    <h3>{sub.name}</h3>
    {#each msgs.current as m (m.id)}<p>{m.content}</p>{/each}
    {#each calls.current as c (c.id)}<code>{c.name}</code>{/each}
  </section>
{/each}
```

## Reading per-message metadata

`useMessageMetadata` exposes the parent checkpoint id, which drives fork / edit flows:

```svelte
<script lang="ts">
  import { useMessageMetadata } from "@langchain/svelte";
  const meta = useMessageMetadata(stream, () => msg.id);
</script>

Parent: {meta.current?.parentCheckpointId ?? "root"}
```

## Raw events via `useChannel`

Reach for `useChannel` when you need to observe the wire protocol directly — for debugging, telemetry, or bridging to an external event bus. The buffer is bounded; pass `{ limit }` to tune it:

```svelte
<script lang="ts">
  import { useChannel } from "@langchain/svelte";
  const events = useChannel(stream, ["values", "messages"], undefined, { limit: 200 });
</script>

{#each events.current as ev}
  <pre>{JSON.stringify(ev)}</pre>
{/each}
```

The buffer keeps accumulating across serial runs for the lifetime of the thread, so `useChannel` is also the composable to use for an **event log** of a custom channel (e.g. `["custom:redaction-stats"]`):

```svelte
<script lang="ts">
  import { useChannel } from "@langchain/svelte";
  const statsEvents = useChannel(stream, ["custom:redaction-stats"]);
</script>
```

## `useChannel` vs. `useExtension`

Both keep receiving events across serial runs on the same thread, but they expose different shapes for a `custom:<name>` channel:

- **`useExtension`** — the **latest** payload only. Use it for "current state" panels (progress, score, status).
- **`useChannel`** — the **full history** of events as a bounded buffer. Use it when you need an event log or want to derive your own running totals.

## Per-event side effects via `useChannelEffect`

`useChannel` is for events you **render**. When you instead want to **react** to each event — fire analytics, write a log — use `useChannelEffect`. It invokes `onEvent` once per event and returns nothing, so it never re-renders:

```svelte
<script lang="ts">
  import { useChannelEffect } from "@langchain/svelte";

  useChannelEffect(stream, ["lifecycle", "tools"], {
    replay: false,
    onEvent(event) {
      sendAnalytics(event);
    },
    onError(error) {
      logger.error(error);
    },
  });
</script>
```

`channels`, `target`, and `enabled` accept getters so reactive `$state` re-binds the subscription. The subscription is **shared** (ref-counted) with any matching `useChannel`, so you only pay for one server subscription per channel set. `replay` defaults to `false` (live-only); events buffered before the effect attaches are not re-delivered. Call it from a component script or `$effect.root`.

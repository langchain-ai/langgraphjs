# Reading data with selectors

The root handle returned by [`useStream`](./api-reference.md) exposes
the always-on projections (`values`, `messages`, `toolCalls`,
`interrupts`, …). Everything that needs to be **scoped** to a
subagent, subgraph, or namespace lives behind a selector composable.

Selectors are **ref-counted**: the first caller opens a subscription,
and the last consumer's scope disposal closes it. Components that
never render a subagent's content never pay for its wire traffic.

## Available selectors

| Selector | Purpose |
|---|---|
| `useMessages(stream, target?)` | Messages for the target namespace. |
| `useToolCalls(stream, target?)` | Assembled tool calls for the target. |
| `useValues(stream, target?)` | State snapshot for the target. |
| `useMessageMetadata(stream, msgId)` | `{ parentCheckpointId }` for forking / editing. `msgId` accepts a ref / getter. |
| `useSubmissionQueue(stream)` | `{ entries, size, cancel(id), clear() }` for the enqueue strategy. |
| `useExtension(stream, name, target?)` | Latest payload of a `custom:<name>` extension. |
| `useChannel(stream, channels, target?)` | Raw event stream (bounded buffer, all runs) — escape hatch. |
| `useChannelEffect(stream, channels, options)` | Per-event side-effect callback (analytics, logging) — no re-render. |
| `useAudio` / `useImages` / `useVideo` / `useFiles` | Multimodal media streams. |
| `useMediaURL(media)` | Create + revoke an `objectURL` for a media handle. |
| `useAudioPlayer(audio, options?)` | PCM-to-`AudioContext` player with play / pause / seek controls. |
| `useVideoPlayer(video, options?)` | `<video>`-element player with play / pause / seek controls. |

## Target argument

The `target` parameter accepts any of:

- a `SubagentDiscoverySnapshot` / `SubgraphDiscoverySnapshot`,
- a `{ namespace: string[] }` descriptor,
- a raw `string[]`,
- or — because every selector accepts a `MaybeRef` / getter — a
  `ref` / `computed` over any of those, so projections rebind
  automatically when the target changes.

## Example

Root reads are free — they read the already-mounted root projection
directly:

```vue
<script setup lang="ts">
import { computed } from "vue";
import { useStream, useMessages, useValues } from "@langchain/vue";

const stream = useStream({ assistantId: "agent", apiUrl: "/api" });

const rootMessages = useMessages(stream);
const rootValues = useValues(stream);

// Selector composables also return refs in script.
const latestMessage = computed(() => rootMessages.value.at(-1));
const hasValues = computed(() => rootValues.value != null);
</script>
```

Scoped reads open a namespaced subscription on mount. See
[Subagents & subgraphs](./subagents.md) for a full example.

## `useChannel` vs. `useExtension`

For a `custom:<name>` channel both composables keep receiving events
across serial runs on the same thread, but they expose different shapes:

- **`useExtension`** returns the **latest** payload only — ideal for
  "current state" panels (progress, score, status):

  ```vue
  <script setup lang="ts">
  import { useExtension } from "@langchain/vue";
  const telemetry = useExtension<Telemetry>(stream, "telemetry");
  </script>
  ```

- **`useChannel`** returns the **full history** of events as a bounded
  buffer — use it for an event log or to derive your own running totals:

  ```vue
  <script setup lang="ts">
  import { useChannel } from "@langchain/vue";
  const statsEvents = useChannel(stream, ["custom:redaction-stats"]);
  </script>
  ```

## Per-event side effects via `useChannelEffect`

`useChannel` is for events you **render**. When you instead want to
**react** to each event — fire analytics, write a log — use
`useChannelEffect`. It invokes `onEvent` once per event and returns
nothing, so it never re-renders the component:

```vue
<script setup lang="ts">
import { useChannelEffect } from "@langchain/vue";

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

`channels`, `target`, and `enabled` accept `ref`s / getters so reactive
state re-binds the subscription. The subscription is **shared**
(ref-counted) with any matching `useChannel`, so you only pay for one
server subscription per channel set. `replay` defaults to `false`
(live-only); events buffered before the effect attaches are not
re-delivered.

## Lifecycle & cleanup

Each selector hooks into the current Vue scope. When the scope is
disposed (component unmount, `effectScope.stop()`, etc.) the
reference count drops; when it hits zero the underlying subscription
is closed.

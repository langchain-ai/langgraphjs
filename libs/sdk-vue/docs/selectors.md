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
| `useExtension(stream, name, target?)` | Read a named protocol extension. |
| `useChannel(stream, channels, target?)` | Raw event buffer — escape hatch. |
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

## Lifecycle & cleanup

Each selector hooks into the current Vue scope. When the scope is
disposed (component unmount, `effectScope.stop()`, etc.) the
reference count drops; when it hits zero the underlying subscription
is closed.

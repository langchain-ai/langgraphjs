# Subagents & subgraphs

Subagents and subgraphs are discovered eagerly but **streamed
lazily**. The root hook keeps cheap identity snapshots in
`stream.subagents`, `stream.subgraphs`, and `stream.subgraphsByNode`:

```ts
interface SubagentDiscoverySnapshot {
  readonly id: string; // tool-call id that spawned it
  readonly name: string; // "researcher", "writer", …
  readonly namespace: readonly string[];
  readonly parentId: string | null;
  readonly depth: number;
  readonly status: "pending" | "running" | "complete" | "error";
}
```

These snapshots carry **identity only** — no messages, no values, no
tool calls. To render a subagent's content, pass its snapshot to a
selector composable. The subscription is scoped to the subagent's
namespace and reference-counted.

## Example

```vue
<!-- SubagentCard.vue -->
<script setup lang="ts">
import { type PropType } from "vue";
import {
  useMessages,
  useStreamContext,
  useToolCalls,
  type SubagentDiscoverySnapshot,
} from "@langchain/vue";

const props = defineProps({
  subagent: {
    type: Object as PropType<SubagentDiscoverySnapshot>,
    required: true,
  },
});

const stream = useStreamContext();
const messages = useMessages(stream, () => props.subagent);
const toolCalls = useToolCalls(stream, () => props.subagent);
</script>

<template>
  <h4>{{ subagent.name }} ({{ subagent.status }})</h4>
  <div v-for="(m, i) in messages" :key="m.id ?? i">
    {{ typeof m.content === "string" ? m.content : JSON.stringify(m.content) }}
  </div>
  <pre v-for="t in toolCalls" :key="t.id">
    {{ t.name }}: {{ t.status }}
  </pre>
</template>
```

The first consumer of `useMessages(stream, subagent)` opens a scoped
subscription; when the last card unmounts, the subscription is
released.

## Listing subagents

```vue
<script setup lang="ts">
import { computed } from "vue";
import { useStreamContext } from "@langchain/vue";
import SubagentCard from "./SubagentCard.vue";

const stream = useStreamContext();

const researchers = computed(() =>
  [...stream.subagents.value.values()].filter((s) => s.name === "researcher"),
);
</script>

<template>
  <SubagentCard v-for="s in researchers" :key="s.id" :subagent="s" />
</template>
```

## Subgraphs

`stream.subgraphs` is keyed by subgraph id; `stream.subgraphsByNode`
groups them by the graph node that produced them. Both expose the
same `SubgraphDiscoverySnapshot` shape, and both can be fed into
`useMessages` / `useToolCalls` / `useValues` the same way as
subagents.

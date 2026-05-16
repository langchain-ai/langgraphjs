# Stream context (`provideStream` / `getStream`)

Share a single stream across a component tree with `provideStream` / `getStream`. Both must be called during component initialisation (top level of `<script>`), same rule as Svelte's built-in `setContext` / `getContext`.

## Parent

```svelte
<!-- ChatContainer.svelte -->
<script lang="ts">
  import { provideStream } from "@langchain/svelte";
  provideStream({ assistantId: "agent", apiUrl: "http://localhost:2024" });
</script>

<ChatHeader />
<MessageList />
<MessageInput />
```

## Child

```svelte
<!-- MessageList.svelte -->
<script lang="ts">
  import { getStream } from "@langchain/svelte";
  const stream = getStream();
</script>

{#each stream.messages as msg (msg.id)}
  <div>{msg.content}</div>
{/each}
```

### Typing the context

`getStream` accepts the same type parameters as `useStream`, so children can be fully typed:

```ts
import type { myAgent } from "./agent";
const stream = getStream<typeof myAgent>();
```

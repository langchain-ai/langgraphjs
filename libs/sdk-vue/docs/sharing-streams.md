# Sharing a stream

When multiple components need the same stream (a header, a message
list, an input bar), publish a single instance through Vue's
provide / inject layer.

## `provideStream` / `useStreamContext`

```vue
<!-- ChatContainer.vue -->
<script setup lang="ts">
import { provideStream } from "@langchain/vue";

provideStream({
  assistantId: "agent",
  apiUrl: "http://localhost:2024",
});
</script>

<template>
  <ChatHeader />
  <MessageList />
  <MessageInput />
</template>
```

```vue
<!-- MessageList.vue -->
<script setup lang="ts">
import { computed } from "vue";
import { useStreamContext } from "@langchain/vue";

const stream = useStreamContext();

// In scripts, stream fields are refs:
const count = computed(() => stream.messages.value.length);
</script>

<template>
  <!-- In templates, Vue auto-unwraps refs. -->
  <div v-for="(msg, i) in stream.messages" :key="msg.id ?? i">
    {{ typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content) }}
  </div>
</template>
```

`useStreamContext()` throws synchronously if no ancestor has
called `provideStream()`.

## App-level defaults with `LangChainPlugin`

Set shared defaults (typically `apiUrl` + `apiKey`) at the
application level so components only need to specify what's unique
to them:

```typescript
import { createApp } from "vue";
import { LangChainPlugin } from "@langchain/vue";
import App from "./App.vue";

const app = createApp(App);
app.use(LangChainPlugin, {
  apiUrl: "http://localhost:2024",
});
app.mount("#app");
```

Subsequent `useStream({ assistantId: "agent" })` calls inherit
`apiUrl` / `apiKey` / `client` automatically.

## Multiple agents

Every `provideStream` call is scoped to the component subtree it's
declared in, so nested providers get isolated controllers:

```vue
<!-- ResearchPanel.vue -->
<script setup lang="ts">
import { provideStream } from "@langchain/vue";

provideStream({ assistantId: "researcher", apiUrl: "http://localhost:2024" });
</script>

<template>
  <MessageList />
  <MessageInput />
</template>
```

A sibling panel can `provideStream({ assistantId: "writer", ... })`
against the same app root and the two controllers won't interfere.

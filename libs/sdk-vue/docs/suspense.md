# Suspense-style hydration

Because `useStream` exposes `hydrationPromise` as a `ComputedRef`,
you can gate your template on hydration finishing from inside an
`async setup()` instead of writing `<Suspense>`-specific composables:

```vue
<script setup lang="ts">
import { useStream } from "@langchain/vue";

const stream = useStream({
  assistantId: "agent",
  apiUrl: "http://localhost:2024",
  threadId: "t-42",
});

await stream.hydrationPromise.value;
</script>

<template>
  <ChatTranscript :messages="stream.messages" />
</template>
```

Wrap the consuming component in Vue's built-in `<Suspense>` boundary
to render a fallback while hydration is in progress:

```vue
<template>
  <Suspense>
    <template #default>
      <Chat />
    </template>
    <template #fallback>
      <Spinner />
    </template>
  </Suspense>
</template>
```

## When `hydrationPromise` resolves

`stream.hydrationPromise` settles when the thread's initial
hydration resolves (or rejects). A fresh promise is installed every
time the composable binds to a new `threadId` — so switching threads
from `"t-42"` to `"t-43"` re-arms the suspense boundary
automatically.

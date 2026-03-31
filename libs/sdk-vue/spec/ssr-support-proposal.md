# `@langchain/vue` SSR Support Proposal

## Status

Draft

## Summary

`@langchain/vue` already exposes the same core streaming model as the React SDK:
`useStream()`, `provideStream()`, `useStreamContext()`, `joinStream()`, and
`reconnectOnMount` are all built on the shared `StreamOrchestrator`.

That means Vue can already recover an in-flight run after a reload, but the UX
still is not instant:

- the server cannot render the latest known thread state into the initial HTML;
- the browser must boot Vue before the stream can be rejoined;
- reconnect metadata only stores `runId`, so recovery restarts from
  `lastEventId = "-1"` instead of a precise cursor;
- there is no first-class SSR contract for Nuxt, Vite SSR, or custom Vue SSR
  stacks.

This proposal mirrors the React SSR proposal and adapts it to Vue's API
surface. The goal is for SSR DX to feel intentionally aligned across all UI
SDKs while still matching Vue idioms.

## Goals

1. **Instant first paint**
   - Render the latest known conversation state on the server.
   - Hydrate into the same message tree without an empty shell.

2. **Zero-jank stream handoff**
   - If a run is still active, resume from the server-rendered snapshot without
     duplicate messages or visible catch-up.

3. **Vue-native ergonomics**
   - The server API should live under `@langchain/vue/server`.
   - The client API should extend `useStream()` and `provideStream()`, not
     introduce an unrelated SSR-only abstraction.

4. **Cross-SDK DX parity**
   - Vue should use the same snapshot shape, resume token, option names, and
     semantics as React, Svelte, and Angular wherever possible.

5. **Progressive adoption**
   - Existing client-only Vue apps should keep working unchanged.
   - Apps should be able to adopt snapshot-only SSR before resumable hydration.

## Non-goals

- Server-rendering every token into HTML.
- Replacing the existing client-only `useStream()` path.
- Creating a Vue-only resume model that diverges from the other SDKs.

## Current State

Today, `@langchain/vue` supports:

- `initialValues` for immediate client-side rendering while thread history
  loads;
- externally managed `thread` state;
- `provideStream()` / `useStreamContext()` for shared stream trees;
- `reconnectOnMount` via the shared `StreamOrchestrator`.

The current reconnect flow is the same shared path used by the other frontend
SDKs:

1. a run is started with `streamResumable: true`;
2. the browser stores `lg:stream:${threadId} -> runId`;
3. after a reload, the client composable mounts;
4. the orchestrator calls `joinStream(runId)`;
5. `joinStream()` defaults to `lastEventId = "-1"`;
6. the UI converges after the client is running again.

Correctness is good. Perceived latency is not.

## Cross-SDK DX Contract

Vue should participate in the same SSR contract as the other UI SDKs:

- server import path: `@langchain/<framework>/server`
- shared server function name: `getStreamSnapshot`
- shared serialized payload type: `StreamSnapshot`
- shared resume metadata shape: `ResumeToken`
- shared client option name: `ssr`
- shared resume policy: `"never" | "if-in-flight" | "always"`
- `apiUrl` as the default entrypoint, with `client` kept as an escape hatch

Framework-specific differences should only affect how the snapshot is consumed:

- React hydrates through hooks and providers;
- Vue hydrates through composables and `provide` / `inject`;
- Svelte hydrates through functions and context;
- Angular hydrates through `injectStream`, providers, and signals.

## Proposed API

### 1. Add a Vue server entrypoint

Add a server-safe export:

```ts
import {
  getStreamSnapshot,
  type StreamSnapshot,
} from "@langchain/vue/server";
```

Suggested API:

```ts
type StreamSnapshot<StateType> = {
  assistantId: string;
  threadId: string | null;
  values: StateType | null;
  history?: Array<SerializedThreadState<StateType>>;
  branch?: string;
  fetchedAt: string;
  resume?: {
    threadId: string;
    runId: string;
    lastEventId?: string;
    streamMode?: string[];
    expiresAt?: string;
  };
};

type GetStreamSnapshotOptions = {
  assistantId: string;
  threadId: string | null;
  apiUrl?: string;
  apiKey?: string;
  callerOptions?: StreamCallerOptions;
  defaultHeaders?: Record<string, string>;
  client?: StreamClient;
  fetchStateHistory?: boolean | { limit: number };
  includeResume?: boolean;
};

async function getStreamSnapshot<StateType>(
  options: GetStreamSnapshotOptions,
): Promise<StreamSnapshot<StateType>>;
```

Ergonomics should mirror `useStream()`:

- most users pass `assistantId`, `threadId`, and `apiUrl`;
- advanced users can still pass a preconfigured `client`;
- examples should stay fully inside `@langchain/vue`.

### 2. Extend `useStream()` with SSR-aware hydration

Add an optional `ssr` field to `useStream()`:

```ts
const stream = useStream({
  assistantId: "agent",
  apiUrl: runtimeConfig.public.langgraphApiUrl,
  ssr: {
    snapshot,
    resume: "if-in-flight",
  },
});
```

Suggested shape:

```ts
type UseStreamSSROptions<StateType> = {
  snapshot: StreamSnapshot<StateType>;
  resume?: "never" | "if-in-flight" | "always";
  revalidateOnMount?: boolean;
};
```

Client behavior:

1. initialize from `snapshot`;
2. skip redundant refetching unless `revalidateOnMount` is enabled;
3. if `snapshot.resume` is present and `resume !== "never"`, call
   `joinStream(snapshot.resume.runId, snapshot.resume.lastEventId)`;
4. continue streaming from the already-rendered Vue UI.

### 3. Support provider-level SSR hydration

`provideStream()` should accept the same `ssr` option so a Vue subtree can share
one hydrated stream instance.

```ts
provideStream({
  assistantId: "agent",
  apiUrl,
  ssr: {
    snapshot,
    resume: "if-in-flight",
  },
});
```

Child components should continue to use `useStreamContext()` with no SSR-specific
branching logic.

## Shared SDK Changes Required

Vue should rely on the same shared primitives as the React proposal:

### A. Structured resume tokens

Move from storing only `runId` to storing:

```ts
type ResumeToken = {
  threadId: string;
  runId: string;
  lastEventId?: string;
};
```

This requires the shared orchestration layer to track the latest processed event
ID and pass it through reconnect / resume flows.

### B. Shared stream event reduction

The logic that turns streamed events into values, messages, interrupts,
subagents, and tool progress should live in shared SDK utilities so server
snapshots and client hydration use the same semantics.

## Example Usage

### Nuxt page

```vue
<!-- pages/thread/[threadId].vue -->
<script setup lang="ts">
import { getStreamSnapshot } from "@langchain/vue/server";

const route = useRoute();
const runtimeConfig = useRuntimeConfig();

const { data: snapshot } = await useAsyncData("thread-snapshot", () =>
  getStreamSnapshot({
    assistantId: "agent",
    apiUrl: runtimeConfig.langgraphApiUrl,
    threadId: route.params.threadId as string,
    fetchStateHistory: true,
    includeResume: true,
  }),
);
</script>

<template>
  <ChatClient v-if="snapshot" :snapshot="snapshot" />
</template>
```

```vue
<!-- components/ChatClient.vue -->
<script setup lang="ts">
import { useStream } from "@langchain/vue";

const props = defineProps<{ snapshot: any }>();
const runtimeConfig = useRuntimeConfig();

const stream = useStream({
  assistantId: props.snapshot.assistantId,
  apiUrl: runtimeConfig.public.langgraphApiUrl,
  ssr: {
    snapshot: props.snapshot,
    resume: "if-in-flight",
  },
});
</script>

<template>
  <div v-for="(msg, i) in stream.messages" :key="msg.id ?? i">
    {{ msg.content }}
  </div>
</template>
```

### Shared subtree via `provideStream()`

```vue
<script setup lang="ts">
import { provideStream } from "@langchain/vue";

const props = defineProps<{ snapshot: any }>();

provideStream({
  assistantId: props.snapshot.assistantId,
  apiUrl: useRuntimeConfig().public.langgraphApiUrl,
  ssr: {
    snapshot: props.snapshot,
    resume: "if-in-flight",
  },
});
</script>

<template>
  <ChatHeader />
  <MessageList />
  <MessageInput />
</template>
```

## Migration Path

### Phase 1: Snapshot-first SSR

Ship:

- `@langchain/vue/server`
- `getStreamSnapshot()`
- `useStream({ ssr: { snapshot } })`
- `provideStream({ ssr: { snapshot } })`

Outcome:

- server-rendered conversation state on first paint
- no empty shell before hydration

### Phase 2: Precise resumable hydration

Ship:

- structured resume tokens
- tracked `lastEventId`
- exact `joinStream(runId, lastEventId)` handoff

Outcome:

- reload mid-stream feels instant

### Phase 3: Cross-SDK parity

Ship:

- shared reducer utilities
- transport-level snapshot / resume hooks
- docs that intentionally align Vue with React, Svelte, and Angular

## Recommendation

Pursue Vue SSR support as the same product shape proposed for React:

- snapshot first
- cursor-based resume second
- one shared DX contract across all frontend SDKs

The important outcome is not just "Vue gets SSR". It is that a developer moving
between `@langchain/react`, `@langchain/vue`, `@langchain/svelte`, and
`@langchain/angular` should see the same server import, the same snapshot type,
the same `ssr` option, and the same resume semantics.

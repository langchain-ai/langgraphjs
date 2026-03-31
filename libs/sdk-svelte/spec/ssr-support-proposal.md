# `@langchain/svelte` SSR Support Proposal

## Status

Draft

## Summary

`@langchain/svelte` already supports recovering an in-flight run after a reload
via `reconnectOnMount`, `sessionStorage`, and `joinStream()`. That makes the UI
*correct eventually*, but it does not make the UI feel instant:

- the server cannot render the latest known thread state into the HTML response;
- the browser must boot the Svelte app before `joinStream()` can resume the run;
- reconnect metadata only stores `runId`, so client recovery restarts from
  `lastEventId = "-1"` instead of resuming from a precise point;
- the feature is LangGraph Platform-specific and not modeled as a first-class
  SSR handoff API.

This proposal defines a best-in-class SSR story for `@langchain/svelte`: the
server renders the latest known thread state immediately, the client hydrates
without UI flicker, and an in-flight run continues streaming from an explicit
resume token rather than a best-effort browser-only reconnect.

The intended developer experience should closely match the React, Vue, and
Angular SDKs:

- each package exposes a `getStreamSnapshot()` server helper under its own
  package namespace;
- each client adapter accepts an `ssr.snapshot` option;
- each framework can resume an in-flight run from the same `ResumeToken` model;
- examples default to `apiUrl`-first configuration and keep preconfigured
  clients as an advanced escape hatch.

## Goals

1. **Instant first paint on reload**
   - Reloading mid-stream should render the latest known conversation state in
     the initial HTML response.
   - The client should hydrate into the same message list and UI structure
     without showing an empty shell first.

2. **Zero-jank stream handoff**
   - If a run is still in progress, the client should continue streaming from
     the server-rendered snapshot with no duplicate messages, no reset to an
     earlier partial state, and no visible "catch up" phase.

3. **Framework-friendly SSR**
   - The API should work with SvelteKit and custom Svelte SSR stacks.
   - It should compose with both page-level data loading and shared context
     patterns such as `provideStream()`.

4. **Shared runtime model**
   - The snapshot and resume model should be backed by shared SDK primitives,
     not bespoke Svelte-only logic.
   - Svelte should be a thin adapter over reusable stream orchestration.

5. **Cross-SDK consistency**
   - Svelte should use the same conceptual SSR contract as React, Vue, and
     Angular.
   - Developers moving between framework SDKs should learn one model, not four.

6. **Progressive adoption**
   - Existing `useStream()` consumers should keep working.
   - Apps should be able to adopt SSR incrementally, starting with read-only
     snapshots and later enabling resumable streaming.

## Non-goals

- Streaming tokens from the server directly into SSR HTML.
  - The main problem here is preserving conversational state and resuming event
    streams, not server-rendering every token update.
- Replacing the existing client-only `useStream()` path.
  - The current SPA flow should remain supported.
- Solving persistence for every backend automatically.
  - The proposal assumes the LangGraph Platform already persists checkpoints and
    resumable run events when `streamResumable` is enabled.

## Current State

Today, `@langchain/svelte` supports:

- `initialValues` for immediate client-side rendering while thread history
  loads;
- `provideStream()` / `getStream()` / `getStreamContext()` for sharing a stream
  through Svelte context;
- `reconnectOnMount` for browser refresh recovery.

The current reconnect flow is roughly:

1. a run is started with `streamResumable: true`;
2. the browser stores `lg:stream:${threadId} -> runId` in `sessionStorage`;
3. after a reload, the client component mounts;
4. the hook reads `sessionStorage` and calls `joinStream(runId)`;
5. `joinStream()` defaults to `lastEventId = "-1"`;
6. the UI converges to the latest state after the client is live again.

That is enough for correctness, but it has three UX limitations:

### 1. No server-rendered thread snapshot

The server response has no first-class way to render the current thread values
or messages into HTML, so users briefly see a loading or partially empty shell.

### 2. No precise resume cursor

The stored reconnect metadata only includes `runId`. The client therefore joins
from the beginning of the resumable stream instead of from the last event that
the UI has already incorporated.

### 3. No explicit SSR contract

The current API exposes pieces that can help (`initialValues`, `thread`,
`joinStream()`), but it does not define:

- what data the server should fetch;
- how that data should be serialized into HTML;
- how the client should decide whether to rejoin a run;
- how to avoid refetching state that was already rendered by the server.

## Design Principles

1. **Snapshot first, stream second**
   - SSR should always begin with a serializable thread snapshot.
   - Resuming a live run is an enhancement on top of that snapshot.

2. **The server must hand off an explicit resume token**
   - Client recovery should not depend on reading browser-only storage.
   - Storage-backed reconnect remains useful, but SSR should not require it.

3. **Hydration should be deterministic**
   - The state rendered on the server should be the same state the Svelte app
     hydrates on the client before any new events are applied.

4. **Resume from a cursor, not from the beginning**
   - The client should continue from the latest acknowledged event when
     possible.

5. **Keep the transport abstraction intact**
   - LangGraph Platform should get a first-party SSR path.
   - Custom transports should be able to implement the same contract.

6. **DX should stay aligned across SDKs**
   - The package name changes, but the mental model should not.
   - The shared concepts should be `StreamSnapshot`, `ResumeToken`,
     `getStreamSnapshot()`, and `ssr.snapshot`.

## Proposed API

The proposal has two parts:

1. a **server snapshot API** that fetches serializable thread state and optional
   resume metadata;
2. a **client hydration API** that starts from that snapshot and optionally
   rejoins an in-flight run.

### 1. Add a server entrypoint

Add a server-safe export:

```ts
import {
  getStreamSnapshot,
  type StreamSnapshot,
} from "@langchain/svelte/server";
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

Responsibilities:

- fetch the latest thread state or history on the server;
- normalize it into a serializable shape that the client can hydrate from;
- optionally attach resume metadata for an active run if one exists.

The intended ergonomics should mirror `useStream()`:

- most users pass `assistantId`, `threadId`, and `apiUrl`;
- advanced users can still pass a preconfigured `client`, but that should be an
  escape hatch exposed from `@langchain/svelte/server`;
- examples and docs should default to the `apiUrl` path so developers only have
  to learn `@langchain/svelte`.

### 2. Extend `useStream()` with SSR-aware hydration

Add an optional `ssr` field to `useStream()`:

```ts
const stream = useStream({
  assistantId: "agent",
  apiUrl: publicApiUrl,
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

1. initialize `historyValues` and/or `thread` from `snapshot`;
2. skip the initial client refetch unless `revalidateOnMount` is enabled;
3. if `snapshot.resume` is present and `resume !== "never"`, call
   `joinStream(snapshot.resume.runId, snapshot.resume.lastEventId)`;
4. continue streaming from the same UI that was server-rendered.

### 3. Support provider-level SSR composition

`provideStream()` should accept the same `ssr` option so an application can
server-render a shared stream tree once and hydrate multiple child components
from the same source of truth.

```svelte
<script lang="ts">
  import { provideStream } from "@langchain/svelte";

  provideStream({
    assistantId: "agent",
    apiUrl,
    ssr: { snapshot, resume: "if-in-flight" },
  });
</script>
```

This aligns Svelte's shared-context story with React's `StreamProvider`,
Vue's `provideStream()`, and Angular's `provideStream()`.

## Shared SDK Changes Required

The Svelte API above is only ergonomic if the shared SDK grows two lower-level
capabilities.

### A. Persist and expose a real resume cursor

Today reconnect metadata stores `runId`, but not the latest processed event ID.
Best-in-class SSR should carry both:

```ts
type ResumeToken = {
  threadId: string;
  runId: string;
  lastEventId?: string;
};
```

This requires:

- tracking the latest event ID seen by `StreamManager` / `StreamOrchestrator`;
- exposing that value through the reconnect metadata path;
- updating storage from `runId` to a structured payload rather than a bare
  string;
- allowing `joinStream()` to continue from the latest acknowledged event.

Without this, SSR will still "work", but the client will replay more events
than necessary and can visibly re-accumulate partial UI.

### B. Reuse the same state application logic across server and client

The client already knows how to turn stream events into `values`, messages,
interrupts, subagent state, and tool progress. SSR will be more robust if that
logic is available outside Svelte too.

Suggested direction:

- factor the stream event reducer into a shared SDK primitive;
- let both client adapters and server utilities build state using the same
  semantics;
- use that primitive to support future features like precomputing partial UI
  state from buffered events.

This is not strictly required for a first SSR release, but it is the right
foundation if we want parity across React, Vue, Svelte, and Angular adapters.

## Snapshot Lifecycle

### Server request lifecycle

For a request to `/thread/[threadId]`:

1. server receives `threadId`;
2. server calls `getStreamSnapshot({ threadId, includeResume: true })`;
3. the snapshot includes:
   - latest thread state/history;
   - serialized messages/UI values;
   - active run metadata if the thread is currently streaming;
4. server renders HTML using that snapshot.

### Client hydration lifecycle

1. HTML already contains the latest known message list;
2. `useStream({ ssr: { snapshot } })` hydrates from that snapshot;
3. if `snapshot.resume` is present, the client rejoins the stream immediately;
4. new events are appended on top of the rendered state;
5. when the run completes, normal history refresh rules apply.

## Example Usage

### SvelteKit page

```ts
// src/routes/thread/[threadId]/+page.server.ts
import { getStreamSnapshot } from "@langchain/svelte/server";

export async function load({ params }) {
  const snapshot = await getStreamSnapshot({
    assistantId: "agent",
    apiUrl: process.env.LANGGRAPH_API_URL,
    threadId: params.threadId,
    fetchStateHistory: true,
    includeResume: true,
  });

  return { snapshot };
}
```

```svelte
<!-- src/routes/thread/[threadId]/+page.svelte -->
<script lang="ts">
  import { useStream } from "@langchain/svelte";

  let { data } = $props();

  const stream = useStream({
    assistantId: data.snapshot.assistantId,
    apiUrl: "/api/langgraph",
    ssr: {
      snapshot: data.snapshot,
      resume: "if-in-flight",
    },
  });
</script>

{#each stream.messages as message, i (message.id ?? i)}
  <div>{message.content}</div>
{/each}
```

### Shared provider in SvelteKit

```svelte
<script lang="ts">
  import { provideStream } from "@langchain/svelte";

  let { data } = $props();

  provideStream({
    assistantId: data.snapshot.assistantId,
    apiUrl: "/api/langgraph",
    ssr: {
      snapshot: data.snapshot,
      resume: "if-in-flight",
    },
  });
</script>

<MessageList />
<MessageInput />
```

## What "Best in Class" Means

For this feature, "best in class" should mean all of the following are true:

### 1. Reload mid-stream looks instant

The user should see the conversation immediately on page load, not after the
client fetches or resumes.

### 2. Resume is exact

The client resumes from the last acknowledged event instead of replaying the
entire run.

### 3. It works with framework-native shared state patterns

Svelte apps should be able to use the same snapshot either directly with
`useStream()` or through `provideStream()` and `getStream()`.

### 4. It supports custom transports

The transport contract should optionally support:

```ts
interface UseStreamTransport {
  getSnapshot?(options): Promise<StreamSnapshot>;
  joinStream?(resume: ResumeToken, options?): AsyncGenerator<...>;
}
```

LangGraph Platform can ship first, but the public abstraction should not block
custom backends from participating.

### 5. It scales to other frontend adapters

The orchestration and resume primitives should live in the shared SDK so React,
Vue, and Angular can adopt the same model too.

## Backwards Compatibility

This proposal is additive:

- existing `useStream()` and `reconnectOnMount` behavior continues to work;
- apps without SSR do not need to change anything;
- SSR adopters can start with `snapshot` only;
- resume metadata is optional and can be enabled per deployment.

## Migration Path

### Phase 1: Server snapshots

Ship:

- `@langchain/svelte/server`;
- `getStreamSnapshot()`;
- `useStream({ ssr: { snapshot } })`;
- `provideStream({ ssr: { snapshot } })`.

Outcome:

- fully server-rendered thread state on first paint;
- no client-side empty shell;
- optional client revalidation.

### Phase 2: Precise resumable hydration

Ship:

- structured resume tokens;
- tracked `lastEventId`;
- `useStream({ ssr: { snapshot, resume: "if-in-flight" } })`;
- exact `joinStream(runId, lastEventId)` handoff.

Outcome:

- in-flight runs continue with no visible catch-up.

### Phase 3: Cross-transport and cross-framework parity

Ship:

- shared stream event reducer utilities;
- transport-level snapshot/resume hooks;
- equivalent adapter support beyond Svelte.

Outcome:

- one resumable SSR model across the whole SDK family.

## Open Questions

1. **Where should active run metadata come from on the server?**
   - Ideal answer: an API endpoint or thread metadata query that returns the
     current in-flight resumable run for a thread.
   - If that data is not directly queryable today, Phase 1 can ship snapshot-only
     SSR while the backend API catches up.

2. **How long is resume metadata valid?**
   - The proposal includes an optional `expiresAt` field so clients can avoid
     trying to resume obviously stale runs.

3. **Should SSR snapshots include full history or only the thread head?**
   - The answer should mirror `fetchStateHistory`. Most chat UIs only need the
     thread head for rendering, but branching UIs often want recent history.

4. **How should this interact with `reconnectOnMount` storage?**
   - Recommendation: keep storage-based reconnect as a fallback for pure SPA
     usage, but prefer server-issued `snapshot.resume` when present.

5. **Should Svelte expose a new hook name?**
   - Recommendation: no. Extending `useStream()` keeps the mental model simpler
     and avoids splitting features between near-identical APIs.

## Risks

### Snapshot mismatch

If the server serializes one state shape and the client derives another during
hydration, users will see hydration warnings or flicker.

Mitigation:

- hydrate from the exact serialized snapshot before any revalidation;
- keep serialization logic close to shared SDK primitives.

### Resume token drift

If `lastEventId` is stale or missing, the client may replay more events than
expected.

Mitigation:

- store the latest processed event ID in the orchestration layer;
- treat replay as safe but suboptimal.

### API surface creep

Adding both a new server entrypoint and new client options increases surface
area.

Mitigation:

- keep the contract centered on one concept: `StreamSnapshot`.

## Recommendation

Pursue SSR support in two deliberate milestones:

1. **Snapshot-first SSR**
   - Gives immediate product value by making reloads and direct navigations feel
     instant.

2. **Cursor-based stream resume**
   - Eliminates the remaining catch-up gap and makes mid-stream reloads feel
     native.

This path fits the current architecture:

- Svelte already supports injected thread data via `thread` and
  `initialValues`;
- the shared SDK already centralizes stream orchestration;
- `joinStream()` already exists and only needs a stronger resume token.

The main missing piece is not a brand-new abstraction. It is a supported,
end-to-end contract that lets the server render a thread snapshot and lets the
client continue from that exact point.

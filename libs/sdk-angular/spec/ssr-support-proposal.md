# `@langchain/angular` SSR Support Proposal

## Status

Draft

## Summary

`@langchain/angular` already exposes a strong client-side streaming model through
`injectStream()` and shared providers like `provideStream()`, but it does not yet
offer a first-class SSR handoff story. Today an Angular app can recover
eventually after a reload, but it cannot guarantee an instant server-rendered
conversation snapshot plus exact in-flight stream continuation.

This proposal defines a best-in-class SSR story for `@langchain/angular` that
matches the React, Vue, and Svelte SDKs:

- the server renders the latest known thread state immediately;
- the client hydrates Angular Signals from that exact snapshot;
- an in-flight run resumes from an explicit resume token;
- the API surface stays centered on `@langchain/angular`.

## Goals

1. **Instant first paint**
   - SSR should render the latest known thread state into the initial HTML.
   - Hydration should preserve that state without a loading flash.

2. **Exact stream handoff**
   - If a run is still active, the browser should continue streaming from the
     server-rendered snapshot with no duplicate UI and no catch-up replay that
     users can see.

3. **Angular-native ergonomics**
   - The SSR API should feel like a natural extension of `injectStream()`,
     `provideStreamDefaults()`, and `provideStream()`.
   - Angular users should not need to learn low-level `Client` setup for the
     common case.

4. **Cross-SDK parity**
   - The concepts and naming should match React, Vue, and Svelte:
     `getStreamSnapshot()`, `StreamSnapshot`, `resume`, and the same resume
     token semantics.

5. **Progressive adoption**
   - Existing client-only Angular apps should continue working unchanged.
   - Apps should be able to adopt snapshot-only SSR first, then resumable SSR.

## Non-goals

- Streaming tokens directly into HTML responses.
- Replacing the current client-only `injectStream()` path.
- Hiding Angular-specific integration patterns like providers or Signals.

## Current State

Today, `@langchain/angular` provides:

- `injectStream()` as the primary Signals-based entrypoint;
- `useStream` as a deprecated alias of `injectStream()`;
- `provideStreamDefaults()` for app-level configuration;
- `provideStream()` for sharing a stream instance through DI;
- LangGraph Platform streaming through the shared `StreamOrchestrator`;
- browser reconnect behavior through the same orchestrator-level reconnect
  machinery used by the other frontend SDKs.

That gives Angular a good runtime model, but no explicit SSR contract for:

- fetching a thread snapshot on the server;
- serializing that snapshot into the rendered page;
- hydrating Signals from pre-rendered data;
- resuming an in-flight stream from a precise event cursor.

## Design Principles

1. **One shared mental model across SDKs**
   - Angular should use the same server snapshot and resume-token concepts as
     React, Vue, and Svelte.

2. **Angular-specific client ergonomics**
   - The common path should stay centered on `injectStream()` and provider-based
     composition, not a parallel Angular-only abstraction.

3. **Snapshot first**
   - SSR begins with a serialized thread snapshot.
   - Resuming a live run is an enhancement layered on top.

4. **Deterministic hydration**
   - The server-rendered state should be the same state the client hydrates
     before any new stream events are applied.

5. **Resume from a cursor**
   - Rejoining should use a resume token that includes `lastEventId`, not just
     `runId`.

## Proposed API

The proposal has two parts:

1. a server-side snapshot API exported from `@langchain/angular/server`;
2. SSR-aware hydration for `injectStream()` and provider-based stream sharing.

### 1. Add a server entrypoint

Add a server-safe export:

```ts
import {
  getStreamSnapshot,
  type StreamSnapshot,
} from "@langchain/angular/server";
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

The intended ergonomics should mirror `injectStream()`:

- most users pass `assistantId`, `threadId`, and `apiUrl`;
- advanced users can still pass a preconfigured `client`;
- examples should default to framework-owned imports from
  `@langchain/angular/server`.

### 2. Extend `injectStream()` with SSR-aware hydration

Add an optional `ssr` field:

```ts
readonly stream = injectStream({
  assistantId: "agent",
  apiUrl: environment.apiUrl,
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

1. initialize orchestrator history values from `snapshot`;
2. skip the initial refetch unless `revalidateOnMount` is enabled;
3. if `snapshot.resume` is present and `resume !== "never"`, call
   `joinStream(snapshot.resume.runId, snapshot.resume.lastEventId)`;
4. continue streaming from the UI state already rendered by SSR.

Because `useStream` is deprecated in Angular, docs and examples should use
`injectStream()` as the primary API, while the old alias continues to work.

### 3. Support provider-level SSR hydration

`provideStream()` should accept the same `ssr` option so a parent component can
provide a hydrated shared stream to descendants.

```ts
@Component({
  standalone: true,
  providers: [
    provideStream({
      assistantId: "agent",
      apiUrl: environment.apiUrl,
      ssr: { snapshot, resume: "if-in-flight" },
    }),
  ],
  template: `
    <app-chat-header />
    <app-message-list />
    <app-message-input />
  `,
})
export class ChatContainerComponent {}
```

This should be the Angular equivalent of React's `StreamProvider`, Vue's
`provideStream()`, and Svelte's `provideStream()`.

## Shared Cross-SDK Contract

Angular should implement the same high-level SSR contract as React, Vue, and
Svelte:

- `getStreamSnapshot()` lives under the framework package's `/server`
  entrypoint;
- `StreamSnapshot` has the same core fields and resume-token shape;
- `apiUrl` is the default configuration path, with `client` as an advanced
  escape hatch;
- client hydration takes an `ssr` option with `snapshot`, `resume`, and
  `revalidateOnMount`;
- resume uses a structured token with `threadId`, `runId`, and `lastEventId`.

The framework adapters can still feel idiomatic:

- React: `useStream()` / `StreamProvider`
- Vue: `useStream()` / `provideStream()`
- Svelte: `useStream()` / `provideStream()`
- Angular: `injectStream()` / `provideStream()`

The goal is **similar DX, not identical syntax**.

## Shared SDK Changes Required

### A. Persist and expose a real resume cursor

Best-in-class SSR requires a structured resume token:

```ts
type ResumeToken = {
  threadId: string;
  runId: string;
  lastEventId?: string;
};
```

This requires:

- tracking the latest processed event ID in `StreamManager` /
  `StreamOrchestrator`;
- storing structured reconnect metadata instead of a bare `runId`;
- allowing `joinStream()` to continue from the latest acknowledged event.

### B. Reuse the same stream event reducer everywhere

The same state-application logic should power:

- Angular client hydration;
- server-side snapshot helpers;
- future resumable SSR support in the other frontend SDKs.

This work belongs in shared SDK infrastructure, not in Angular-only glue code.

## Example Usage

### Angular SSR route or server loader

```ts
import { getStreamSnapshot } from "@langchain/angular/server";

export async function loadThreadPage(threadId: string) {
  const snapshot = await getStreamSnapshot({
    assistantId: "agent",
    apiUrl: process.env.LANGGRAPH_API_URL,
    threadId,
    fetchStateHistory: true,
    includeResume: true,
  });

  return { snapshot };
}
```

### Hydrating `injectStream()` in a component

```ts
import { Component, inject } from "@angular/core";
import { injectStream } from "@langchain/angular";
import { THREAD_SNAPSHOT } from "./tokens";

@Component({
  standalone: true,
  template: `
    @for (msg of stream.messages(); track msg.id ?? $index) {
      <div>{{ msg.content }}</div>
    }
  `,
})
export class ChatComponent {
  private readonly snapshot = inject(THREAD_SNAPSHOT);

  readonly stream = injectStream({
    assistantId: this.snapshot.assistantId,
    apiUrl: "/api/langgraph",
    ssr: {
      snapshot: this.snapshot,
      resume: "if-in-flight",
    },
  });
}
```

### Shared provider hydration

```ts
providers: [
  provideStream({
    assistantId: snapshot.assistantId,
    apiUrl: "/api/langgraph",
    ssr: { snapshot, resume: "if-in-flight" },
  }),
];
```

## Migration Path

### Phase 1: Snapshot-first SSR

Ship:

- `@langchain/angular/server`;
- `getStreamSnapshot()`;
- `injectStream({ ssr: { snapshot } })`;
- `provideStream({ ssr: { snapshot } })`.

Outcome:

- Angular apps can server-render thread state immediately;
- client hydration becomes deterministic and flicker-free.

### Phase 2: Precise resumable hydration

Ship:

- structured resume tokens;
- tracked `lastEventId`;
- exact `joinStream(runId, lastEventId)` handoff.

Outcome:

- reload mid-stream continues with no visible catch-up.

### Phase 3: Cross-SDK parity

Ship:

- shared reducer primitives;
- equivalent SSR ergonomics across React, Vue, Svelte, and Angular;
- transport-level snapshot/resume hooks.

Outcome:

- one frontend SSR model across the LangChain UI SDK family.

## Open Questions

1. **What is the best Angular SSR integration point?**
   - It may be route-level data loading, server bootstrap hooks, or custom DI
     tokens depending on the app architecture.

2. **Should Angular expose any helper for wiring snapshots into DI?**
   - A tiny helper could be useful, but the proposal should stay centered on the
     same `StreamSnapshot` contract as the other SDKs.

3. **How should this interact with `provideStreamDefaults()`?**
   - Recommendation: defaults still apply, but `ssr.snapshot` should be explicit
     so hydration remains deterministic.

4. **Should docs mention `useStream` at all?**
   - Recommendation: keep compatibility, but position `injectStream()` as the
     primary Angular API everywhere.

## Recommendation

Pursue Angular SSR support as part of a coordinated frontend SDK effort:

1. ship `StreamSnapshot` and `getStreamSnapshot()` under framework-owned server
   entrypoints;
2. add `ssr` hydration options to Angular's client and provider APIs;
3. implement exact resume-token handoff in shared SDK infrastructure.

That gives Angular an idiomatic Signals-based SSR story while preserving the
same core developer experience as React, Vue, and Svelte.

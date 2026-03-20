# UI SDK Packages Idiomatic Review

A deep review of `@langchain/react`, `@langchain/vue`, `@langchain/svelte`, and `@langchain/angular` examining whether each package follows idiomatic patterns for its framework and identifying improvements to developer experience.

---

## Architecture Overview

All four packages follow the same architectural pattern:

1. **Shared core** (`@langchain/langgraph-sdk/ui`): `StreamManager`, `MessageTupleManager`, `PendingRunsTracker`, `FetchStreamTransport`, and all event processing logic.
2. **Framework adapter**: Each package wraps the shared core in framework-specific reactivity primitives (hooks, refs/computed, stores, signals).
3. **`@langchain/core` integration**: Each package wraps SDK `Message` objects into `BaseMessage` class instances via `toMessageClass`/`ensureMessageInstances`.

This is a solid architecture -- the heavy lifting happens once in the shared layer, and each package is a relatively thin reactivity adapter. The main issues are in the adapter-level patterns, feature parity, and naming consistency.

---

## Per-Framework Analysis

### React (`@langchain/react`)

**What's idiomatic:**
- `useSyncExternalStore` to subscribe to `StreamManager` -- the correct React 18+ pattern for external stores
- `useCallback`, `useRef`, `useMemo`, `useEffect` used appropriately throughout
- `StreamProvider` / `useStreamContext` for React Context prop-drilling avoidance
- `useSuspenseStream` with proper throw-promise Suspense integration
- `"use client"` directives for Next.js App Router compatibility

**Issues and improvement opportunities:**

| # | Issue | Severity | Detail |
|---|-------|----------|--------|
| R1 | **Conditional hook dispatch** | Medium | `useStream` calls `useStreamCustom` or `useStreamLGP` conditionally, guarded by `useState(isCustomOptions(...))`. While functionally safe (the branch is stable), it violates React's Rules of Hooks and requires `eslint-disable`. This is a signal to future contributors that the pattern is fragile. A single unified hook that internally branches without calling separate hooks would be cleaner. |
| R2 | **Inconsistent value wrapping** | Low | The return object mixes getters (`get values()`, `get messages()`) with plain properties (`error`, `isLoading`). `error` and `isLoading` are read directly from `stream.error`/`stream.isLoading` and don't update without re-render triggered by `useSyncExternalStore`. This works but is conceptually inconsistent -- some properties are lazy (getters), others are snapshot values. |
| R3 | **Module-level Suspense cache** | Medium | `useSuspenseStream` uses a module-scoped `Map` for cache. This is not friendly for testing (shared state across tests), React Server Components, or apps with multiple React roots. Consider a context-scoped cache or integration with a cache provider. |
| R4 | **Missing `toolProgress` in custom transport** | Low | `toolProgress` and `handleToolEvent` are only implemented in the LGP path. Custom transport users cannot track tool progress. |
| R5 | **No error type narrowing** | Low | `stream.error` is typed as `unknown`. A discriminated error type (e.g., `StreamError | NetworkError | TimeoutError`) would improve DX for error handling. |
| R6 | **`useSuspenseStream` return object manually mirrors main hook** | Low | The return object in `useSuspenseStream` manually lists every property with delegating getters. This is maintenance-heavy and easy to miss when adding new properties. |

---

### Vue (`@langchain/vue`)

**What's idiomatic:**
- `ref`, `shallowRef`, `computed`, `watch` used correctly
- `VueReactiveOptions` allows options like `assistantId`, `threadId` to be `Ref | Getter | plain value` via `MaybeRefOrGetter` -- very Vue-idiomatic
- `LangChainPlugin` for app-wide defaults via `app.use()` -- standard Vue plugin pattern
- `provideStream` / `useStreamContext` using Vue's `provide`/`inject`
- `reactive()` for queue to auto-unwrap nested refs in templates
- `onScopeDispose` for cleanup -- correct effectScope-aware pattern

**Issues and improvement opportunities:**

| # | Issue | Severity | Detail |
|---|-------|----------|--------|
| V1 | **Subagent reactivity workaround** | Medium | `subagents` and `activeSubagents` use `void subagentVersion.value` to force reactivity tracking on a non-reactive `Map`. This works but is brittle -- developers reading the code may not understand why. A `shallowRef`-wrapped subagent state would be more idiomatic. |
| V2 | **Inconsistent return type wrapping** | Medium | `values` and `error` are `ComputedRef`, `isLoading` is a `ShallowRef`, `branch` is a `Ref`, while `client` and `assistantId` are getters. The `WithClassMessages` type mapping is complex. Vue developers expect consistent `Ref`/`ComputedRef` wrapping. |
| V3 | **Missing `toolProgress`** | Medium | The `toolProgress` feature (tracking tool start/event/end/error) is absent. React has it; Vue doesn't. |
| V4 | **No Vue Suspense support** | Medium | Vue 3 has experimental Suspense support via async `setup()`. There's no `useSuspenseStream` equivalent. |
| V5 | **`callbackStreamModes` not reactive** | Low | The callback stream modes are computed once at setup time. If a callback like `onUpdateEvent` is added dynamically (e.g., via a reactive prop), it won't be picked up. |
| V6 | **`reconnectOnMount` evaluated once** | Low | The `runMetadataStorage` is evaluated immediately and never re-evaluated. In Vue, where options can be reactive, this is unexpected. |
| V7 | **`LangChainPlugin` options not merged into `useStream`** | Low | The plugin provides `LANGCHAIN_OPTIONS` but `useStream` doesn't inject or use it. Only `provideStream` in `context.ts` has no default merging either. The plugin's purpose is documentation-only unless the user manually injects defaults. |

---

### Svelte (`@langchain/svelte`)

**What's idiomatic:**
- Svelte 5 runes-compatible via `fromStore` bridge -- correct migration strategy
- Getter-based return allows clean template access (`stream.messages` instead of `$messages`)
- Uses `writable`, `derived` for reactive state

**Issues and improvement opportunities:**

| # | Issue | Severity | Detail |
|---|-------|----------|--------|
| S1 | **Two overlapping context APIs** | High | The package exports both `setStreamContext`/`getStreamContext` (using `Symbol.for("langchain:stream-context")`) AND `provideStream`/`getStream` (using `Symbol("langchain-stream")`). These are independent systems with different symbols. Having two ways to do the same thing is confusing and one should be consolidated or deprecated. |
| S2 | **`useStream` naming convention** | Medium | The `use` prefix is a React convention (required by React's Rules of Hooks). Svelte traditionally uses `createXxx` for factory functions or plain names. While Svelte 5 doesn't mandate a naming convention, `createStream` or just `stream` would feel more native. |
| S3 | **Still on Svelte 4 store APIs** | Medium | The implementation uses `writable`, `derived`, `get`, `fromStore` -- all Svelte 4 store APIs bridged to Svelte 5 via `fromStore`. A native Svelte 5 implementation using `$state`, `$derived`, and `$effect` runes would be more idiomatic and simpler (no `fromStore` bridge needed). |
| S4 | **`client` not reactive to options** | Low | Unlike Vue which uses `computed(() => new Client(...))`, Svelte constructs the client once: `options.client ?? new Client({ apiUrl: options.apiUrl })`. If `apiUrl` changes, the client won't update. |
| S5 | **`streamMode` manually hardcoded** | Low | The `submitDirect` function hardcodes `["values", "messages-tuple", "updates"]` as default stream modes, then manually checks each callback option. React uses `trackStreamMode` for lazy mode tracking. Svelte doesn't have this optimization. |
| S6 | **Missing `toolProgress`** | Medium | Not implemented. |
| S7 | **Missing `threadIdStreaming` guard** | Low | React uses `threadIdStreamingRef` to suppress history fetch when a stream was just started. Svelte doesn't track this, which could cause unnecessary history fetches. |
| S8 | **`onMount`/`onDestroy` in a factory function** | Low | `useStream` is a plain function that calls Svelte lifecycle hooks (`onMount`, `onDestroy`). This works when called from a component `<script>` block but will fail silently if called outside component context (e.g., in a utility module). No guard or error message is provided. |

---

### Angular (`@langchain/angular`)

**What's idiomatic:**
- Uses Angular Signals (`signal`, `computed`, `effect`) -- the modern Angular reactive pattern
- `StreamService` as `@Injectable()` with proper class-based DI
- `provideStreamDefaults()` with `makeEnvironmentProviders` -- standard Angular provider pattern
- `provideStream()` / `injectStream()` using `InjectionToken` -- correct Angular DI
- `AngularSignalWrap` type properly wraps reactive vs. plain keys

**Issues and improvement opportunities:**

| # | Issue | Severity | Detail |
|---|-------|----------|--------|
| A1 | **`useStream` naming** | Medium | `useStream()` as a free function is a React convention. Angular developers expect to use DI (`inject()`) or services. While `injectStream()` is provided, the primary documented API is `useStream()`, which feels foreign. |
| A2 | **No RxJS interop** | Medium | Angular's ecosystem is built on RxJS. There's no `toObservable()` helper to convert signals to observables, no `pipe()` support for the stream. Many Angular libraries and patterns expect `Observable<T>`. A `toObservable(stream.messages)` utility or an RxJS-based alternative API would serve the Angular ecosystem better. |
| A3 | **`StreamService._stream` typed as `any`** | Medium | The internal `_stream` property loses all type safety. This means the service's typed getters are only as safe as the manual type annotations. |
| A4 | **`pendingRuns.subscribe()` cleanup missing** | Low | The `stream.subscribe()` is wrapped in an `effect` with `onCleanup`, but `pendingRuns.subscribe()` is called directly without cleanup. This could leak subscriptions if the injection context is destroyed. |
| A5 | **Missing `toolProgress`** | Medium | Not implemented. |
| A6 | **`useStream()` must run in injection context** | Low | `useStream()` uses `effect()` from `@angular/core`, which requires an injection context. If called outside one (e.g., in a plain function), it fails with a cryptic Angular error. No guard or helpful error message is provided. |
| A7 | **`effect()` for drain queue** | Low | The `drainQueue` effect (`effect(() => { drainQueue(); })`) relies on Angular's signal auto-tracking to detect `isLoading()` access inside `drainQueue`. This is implicit and fragile -- if `drainQueue` is refactored to not read `isLoading()` directly, the effect would stop triggering. |
| A8 | **Missing `unique()` for stream modes** | Low | Angular uses `new Set()` for stream modes in `submitDirect`, but doesn't use the shared `unique()` utility. Minor inconsistency. |

---

## Cross-Cutting Issues

### 1. Feature Parity Gaps

| Feature | React | Vue | Svelte | Angular |
|---------|-------|-----|--------|---------|
| `toolProgress` | Yes | No | No | No |
| `useSuspenseStream` | Yes | No | No | No |
| `LangChainPlugin` (app defaults) | No | Yes | No | Yes (`provideStreamDefaults`) |
| Lazy `trackStreamMode` | Yes | No | No | No |
| `threadIdStreaming` guard | Yes | Yes | No | No |
| `reconnectOnMount` thread change watcher | Yes | Yes | Yes | Yes |
| Reactive `client` option | Yes (`useMemo`) | Yes (`computed`) | No | No |
| `onToolEvent` callback | Yes | Yes (via callbacks) | Yes (via callbacks) | Yes (via callbacks) |

`toolProgress` and lazy `trackStreamMode` are the most impactful gaps. `toolProgress` enables progress indicators during tool execution, which is critical for agent UX. Lazy stream mode tracking avoids sending unnecessary stream modes to the backend, reducing bandwidth.

### 2. Massive Code Duplication

Each framework package contains ~600-900 lines of largely duplicated logic:
- `fetchHistory` (identical across all four)
- `submitDirect` / `submit` (identical logic, different reactivity wrappers)
- `joinStream` (identical logic)
- `drainQueue` (identical logic)
- `stop` (identical logic)
- `switchThread` (identical logic)
- Reconnect logic (mostly identical)
- Interrupt extraction (identical)
- Tool calls extraction (identical)
- Message metadata extraction (identical)

This is a maintenance burden. When a bug is fixed or feature added in one package, it must be manually replicated in three others. There have already been subtle divergences (e.g., Svelte missing `threadIdStreaming`, Angular using `Set` vs. `unique()`).

**Recommendation:** Extract a framework-agnostic "orchestrator" class (similar to `StreamManager` but higher-level) that handles the submit/join/drain/reconnect/stop lifecycle. Each framework package would then only need to:
1. Instantiate the orchestrator
2. Subscribe for state changes
3. Expose state via framework-native reactivity

### 3. Inconsistent Context/DI Naming

| Concept | React | Vue | Svelte | Angular |
|---------|-------|-----|--------|---------|
| Create + provide | `StreamProvider` | `provideStream` | `provideStream` + `setStreamContext` | `provideStream` |
| Consume | `useStreamContext` | `useStreamContext` | `getStream` + `getStreamContext` | `injectStream` |
| App-level defaults | -- | `LangChainPlugin` | -- | `provideStreamDefaults` |

Svelte has two context systems. The naming is inconsistent across frameworks. A consistent mental model would help developers who work across frameworks or read cross-framework docs.

### 4. `optimisticValues` Ergonomics

The most common use case -- sending a chat message -- requires verbose boilerplate:

```typescript
submit(
  { messages: [{ content: input, type: "human" }] },
  {
    optimisticValues: (prev) => ({
      ...prev,
      messages: [...((prev.messages ?? []) as Message[]), { content: input, type: "human" }],
    }),
  }
);
```

This is the same pattern in every example and every app. A helper like `submitMessage(content)` or auto-optimistic-append for message inputs would dramatically improve DX.

### 5. No Error Type System

`stream.error` is typed as `unknown` across all packages. Developers must do manual type narrowing:

```typescript
if (error instanceof StreamError) { ... }
else if (error instanceof Error) { ... }
```

A discriminated error type would improve DX:

```typescript
type StreamErrorType =
  | { type: "network"; status?: number; message: string }
  | { type: "stream"; error: StreamError }
  | { type: "abort"; reason: string }
  | { type: "unknown"; error: unknown };
```

### 6. SSR/SSG Story

- React has `"use client"` directives but no SSR-specific documentation or hydration helpers
- Vue has no SSR consideration (no conditional `import.meta.env.SSR` guards)
- Svelte has no SvelteKit integration guide
- Angular has no Angular Universal consideration

All packages use `window.sessionStorage` without SSR guards (the `typeof window === "undefined"` checks exist in some places but not all).

### 7. Type Complexity vs. DX

The type system is extremely powerful but produces complex hover types in IDEs. For example:

```typescript
const stream = useStream<typeof agent>({ ... });
// Hover type shows: WithClassMessages<ResolveStreamInterface<typeof agent, InferBag<typeof agent, BagTemplate>>>
```

This is intimidating for developers. Consider adding a simplified named type that resolves more clearly.

---

## Prioritized Improvement Recommendations

### High Priority

1. **Extract shared orchestrator to reduce duplication (all packages)**
   - Create a `StreamOrchestrator` class in `@langchain/langgraph-sdk/ui` that handles submit/join/drain/reconnect/stop lifecycle
   - Each framework adapter becomes ~100-200 lines of reactivity wiring instead of ~600-900 lines of duplicated logic
   - Ensures feature parity by default

2. **Add `toolProgress` to Vue, Svelte, Angular**
   - This is a significant UX feature that React users have but others don't
   - With the shared orchestrator, this would come for free

3. **Consolidate Svelte's two context APIs**
   - Deprecate one of `setStreamContext`/`getStreamContext` vs. `provideStream`/`getStream`
   - Recommend: keep `provideStream`/`getStream` (consistent with Vue) and mark the other as deprecated

4. **Add `submitMessage` convenience helper (all packages)**
   - `stream.submitMessage("Hello")` as sugar for the common send-human-message-with-optimistic-update pattern
   - Dramatically simplifies the most common use case

### Medium Priority

5. **Svelte 5 runes-native implementation**
   - Rewrite using `$state`, `$derived`, `$effect` instead of stores + `fromStore` bridge
   - Simpler, more performant, and more idiomatic for Svelte 5

6. **Angular RxJS interop layer**
   - Add `toObservable()` utilities or an RxJS-based alternative API
   - Angular developers heavily use `pipe()`, `switchMap()`, `takeUntil()` patterns

7. **Consistent naming across frameworks**
   - Adopt a naming convention that respects each framework's idioms:
     - React: `useStream`, `StreamProvider`, `useStreamContext`
     - Vue: `useStream`, `provideStream`, `useStreamContext`
     - Svelte: `createStream`, `provideStream`, `getStream`
     - Angular: `useStream` (keep for now) or `injectStream`, `provideStream`, `injectStream`

8. **Add lazy `trackStreamMode` to Vue, Svelte, Angular**
   - Avoids sending unnecessary stream modes to backend
   - Reduces bandwidth and processing overhead

9. **Fix conditional hook call in React**
   - Use a single hook implementation that internally branches without calling separate hooks conditionally
   - Removes the `eslint-disable react-hooks/rules-of-hooks` escape hatch

### Low Priority

10. **Typed error system (all packages)**
    - Replace `error: unknown` with a discriminated union or branded error type
    - Improves error handling DX

11. **SSR documentation and guards (all packages)**
    - Document SSR behavior for each framework (Next.js, Nuxt, SvelteKit, Angular Universal)
    - Ensure all `window`/`sessionStorage` access is properly guarded

12. **Vue `LangChainPlugin` integration with `useStream`**
    - Make `useStream` automatically inject `LANGCHAIN_OPTIONS` when available
    - Currently the plugin provides defaults but `useStream` doesn't read them

13. **Simplify IDE hover types**
    - Add named type aliases that resolve to friendlier shapes
    - Consider a `StreamInstance<T>` type that's easy to read in tooltips

14. **Fix Angular `pendingRuns.subscribe()` cleanup**
    - Wrap in `effect` with `onCleanup` like `stream.subscribe` is handled

15. **Guard lifecycle calls in Svelte and Angular**
    - Detect when `useStream` is called outside a valid context (component init for Svelte, injection context for Angular) and throw a helpful error message

---

## Summary

Overall the packages are well-engineered with a smart shared-core architecture. The main areas for improvement are:

- **Feature parity**: `toolProgress` and `trackStreamMode` should be available in all frameworks, not just React
- **Code duplication**: A shared orchestrator would eliminate ~70% of per-package code and prevent divergence
- **Naming/API consistency**: Two context systems in Svelte and inconsistent naming across frameworks add cognitive load
- **DX ergonomics**: A `submitMessage` helper would simplify the most common use case dramatically
- **Framework idioms**: Svelte should migrate to runes, Angular should offer RxJS interop, Vue should integrate its plugin with `useStream`

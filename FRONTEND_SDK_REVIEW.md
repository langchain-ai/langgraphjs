# Frontend SDK Review: @langchain/react, @langchain/svelte, @langchain/vue, @langchain/angular

## Executive Summary

The four frontend SDK packages share a well-designed architecture built around a common `StreamOrchestrator` / `StreamManager` core from `@langchain/langgraph-sdk/ui`. Each package adapts the core to its framework's reactivity model. The type system is sophisticated, with strong generics for agent types, tool calls, and subagent inference. However, there are several cross-cutting issues around **API consistency between LGP and custom transport paths**, **`isLoading` bugs in Angular's custom transport**, **documentation errors**, and **framework-idiom adherence** that affect developer experience.

---

## 1. Architecture Overview

All four packages follow this layered design:

```
Framework SDK (React/Svelte/Vue/Angular)
    │
    ▼
StreamOrchestrator / StreamManager  (@langchain/langgraph-sdk/ui)
    │
    ▼
Client  (@langchain/langgraph-sdk)  →  LangGraph Platform API
```

Each package provides:
- A main entry function (`useStream` / `injectStream`)
- Dispatch logic: LGP path vs custom transport path (based on `transport` in options)
- A context/DI mechanism for sharing stream state across component trees
- Type mapping from SDK `Message` to `@langchain/core` `BaseMessage` (`WithClassMessages<T>`)
- Subagent, branching, history, queue, and interrupt support

| Package | Entry Point | Context API | Reactivity Primitive |
|---------|-------------|-------------|---------------------|
| React | `useStream()` | `useStreamContext()` (react-ui) | `useSyncExternalStore` + getters |
| Svelte | `useStream()` | `setStreamContext()` / `getStreamContext()` / `provideStream()` / `getStream()` | Svelte stores + `fromStore` + getters |
| Vue | `useStream()` | `provideStream()` / `useStreamContext()` / `LangChainPlugin` | `ref` / `computed` / `reactive` |
| Angular | `injectStream()` | `provideStream()` / `provideStreamDefaults()` | `signal` / `computed` / `effect` |

---

## 2. Cross-Cutting Issues

### 2.1 `isLoading` Bug in Angular Custom Transport

**Severity: High** — This is a functional bug.

In `libs/sdk-angular/src/stream.custom.ts:59`, `isLoading` is a hardcoded `signal(false)`:

```59:59:libs/sdk-angular/src/stream.custom.ts
    isLoading: signal(false),
```

The orchestrator subscription (lines 29–35) bumps a `version` signal on state changes, but never syncs `orchestrator.isLoading` into the exposed `isLoading` signal. Compare with Vue's correct implementation:

```49:52:libs/sdk-vue/src/stream.custom.ts
  const unsubscribe = orchestrator.subscribe(() => {
    streamValues.value = orchestrator.streamValues;
    streamError.value = orchestrator.error;
    isLoading.value = orchestrator.isLoading;
```

Angular's custom transport users will always see `isLoading() === false`, even during active streaming. This breaks loading indicators, disabled-button patterns, and any logic conditioned on loading state.

### 2.2 Feature Parity Gap: LGP vs Custom Transport

All four packages have a significant feature gap between the LGP and custom transport paths:

| Feature | LGP Path | Custom Transport |
|---------|----------|-----------------|
| `history` | ✅ | ❌ |
| `isThreadLoading` | ✅ | ❌ |
| `experimental_branchTree` | ✅ | ❌ |
| `joinStream` | ✅ | ❌ |
| `queue` (reactive) | ✅ | ❌ (always empty/stubbed) |
| `client` / `assistantId` | ✅ | ❌ |

The custom transport stubs `queue` with static empty values across all packages:

```87:94:libs/sdk-angular/src/stream.custom.ts
    queue: {
      entries: signal([]),
      size: signal(0),
      async cancel() {
        return false;
      },
      async clear() {},
    },
```

```113:120:libs/sdk-vue/src/stream.custom.ts
    queue: {
      entries: [],
      size: 0,
      async cancel() {
        return false;
      },
      async clear() {},
    },
```

While there may be valid reasons for this (custom transports don't have server-side queuing), the lack of documentation about what doesn't work is a DX concern. Users switching from LGP to a custom transport will discover these gaps only at runtime.

### 2.3 `WithClassMessages<T>` Type Mapping Duplication

The `WithClassMessages<T>` type is independently defined in each package with near-identical logic. The Angular version (in `libs/sdk-angular/src/index.ts:63–159`) and the Svelte version (in `libs/sdk-svelte/src/index.ts:195–285`) are essentially the same ~90-line mapped type. The Vue version (in `libs/sdk-vue/src/index.ts:334–424`) differs slightly because it wraps values in `Ref`/`ComputedRef`. The React version lives in `libs/sdk/src/react/types.tsx`.

This duplication increases the chance of drift between packages. Consider extracting a shared generic from `@langchain/langgraph-sdk/ui` that each package can specialize.

### 2.4 README Documentation Errors

**Wrong import path for `BaseMessage`:**

All three non-React READMEs use `import type { BaseMessage } from "langchain"` in their type-safety examples. The correct import is `from "@langchain/core/messages"`, which matches the actual `peerDependency`.

Svelte README (lines 89, 108):
```
import type { BaseMessage } from "langchain";
```

**Vue README: `.value` in templates:**

The Vue README examples use `.value` in `<template>` blocks where Vue auto-unwraps refs:

```325:325:libs/sdk-vue/README.md
  <div v-for="(msg, i) in messages.value" :key="msg.id ?? i">
```

```349:349:libs/sdk-vue/README.md
    <button :disabled="isLoading.value" type="submit">Send</button>
```

This is incorrect for destructured `computed`/`ref` values in Vue templates. It should be `messages` and `isLoading` without `.value`.

---

## 3. Per-Package Analysis

### 3.1 @langchain/react

**Location:** `libs/sdk/src/react/`

#### Idiomatic Patterns ✅

- **`useSyncExternalStore`**: Correctly used to subscribe to `StreamManager` without tearing. This is the recommended React pattern for external state.
- **`useCallback` / `useMemo`**: Used for `submit`, `stop`, client, and derived values.
- **`useRef`**: Used for non-reactive values (callbacks, thread IDs).
- **`"use client"` directive**: Present on stream modules for Next.js App Router compatibility.
- **Controlled/uncontrolled thread ID** (`useControllableThreadId`): Standard React pattern.

#### Non-Idiomatic Patterns ⚠️

1. **Conditional hooks in `useStream`** (lines 39–51 of `stream.tsx`):

```39:51:libs/sdk/src/react/stream.tsx
export function useStream(options: any): any {
  const [isCustom] = useState(isCustomOptions(options));
  if (isCustom) {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    return useStreamCustom(options);
  }
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return useStreamLGP(options);
}
```

This violates React's Rules of Hooks. While the `useState` trick ensures `isCustom` is stable across re-renders, it means the transport mode is **permanently locked** to whatever was passed on first render. If a user ever changes `options` to add/remove `transport`, the hook won't switch — a subtle, hard-to-debug issue.

2. **Getter-based API with side effects**: The LGP hook returns an object with getters that call `trackStreamMode()` on access. This means reading `.values` or `.messages` has the side effect of modifying which stream modes are requested from the server. While clever for optimization, it violates the principle of least surprise and makes debugging difficult.

3. **`FetchStreamTransport` duplication**: The class is defined in both `stream.custom.tsx` and `ui/transport.ts` — only the React version is exported from the React subpath.

4. **Large file size**: `stream.lgp.tsx` is ~890 lines, mixing stream management, history fetching, branching, reconnection, and the returned API surface in a single function.

#### Developer Experience

- **Strong type inference**: `useStream<typeof agent>()` correctly infers tool calls, subagent types, and state shape.
- **Good JSDoc coverage** on interfaces and exported types.
- **Rich examples** in `examples/ui-react/src/examples/`.
- **Suppressed ESLint rules** (`react-hooks/rules-of-hooks`, `react-hooks/exhaustive-deps`) in several places — each is documented but adds fragility.

---

### 3.2 @langchain/svelte

**Location:** `libs/sdk-svelte/`

#### Idiomatic Patterns ✅

- **Store-to-rune bridge via `fromStore`**: Uses Svelte 5's `fromStore` to convert Svelte 4 stores into rune-compatible getters. This is the recommended migration pattern.
- **`onMount` / `onDestroy`**: Correctly used for lifecycle management.
- **Getter-based return**: Returns an object with getters (e.g., `get messages()`) that read from `fromStore` refs. This works well with Svelte 5's fine-grained reactivity.
- **Test components** use `$props()`, `$state`, `$derived`, and `$effect` — proper Svelte 5 patterns.
- **README** correctly warns against destructuring reactive properties.

#### Non-Idiomatic Patterns ⚠️

1. **Store-based architecture instead of native runes**: The core logic uses Svelte 4 `writable` and `derived` stores, then bridges to Svelte 5 via `fromStore`. For a Svelte 5-first SDK, native `$state`/`$derived`/`$effect` would be more direct and idiomatic. The `fromStore` bridge adds overhead and indirection.

2. **Duplicate context APIs**: There are two pairs of context functions that are functionally identical:
   - `setStreamContext()` / `getStreamContext()` — manual context wiring
   - `provideStream()` / `getStream()` — creates stream and provides it

   Both use the same context key (`Symbol.for("langchain:stream-context")`), making them fully interchangeable. This is confusing — developers won't know which to use. The README doesn't clearly explain the difference.

3. **`useStream` naming**: The `use` prefix is a React convention. While adopted here for cross-SDK consistency, it doesn't follow Svelte conventions where functions are typically named without the `use` prefix.

#### Developer Experience

- **Good README** with examples for quick start, options, interrupts, branching, queuing, context, and custom transport.
- **JSDoc** on exported functions with examples.
- **Type tests** (`stream.test-d.ts`, `createAgent.test-d.ts`, `createDeepAgent.test-d.ts`) ensure `BaseMessage` typing is correct.
- **22+ test components** covering diverse scenarios.

---

### 3.3 @langchain/vue

**Location:** `libs/sdk-vue/`

#### Idiomatic Patterns ✅

- **Composable pattern**: `useStream`, `useStreamContext`, `provideStream` follow Vue's composition API conventions perfectly.
- **`MaybeRefOrGetter` for reactive options**: `VueReactiveOptions<T>` wraps specific option keys to accept `Ref`, `ComputedRef`, or getter functions. This is idiomatic Vue for composables that accept reactive inputs.
- **`computed` / `ref` / `shallowRef`**: Proper use of Vue's reactivity primitives. `shallowRef` is used where deep reactivity isn't needed (e.g., version counter).
- **`onScopeDispose`**: Used for cleanup instead of `onUnmounted`, which is more flexible and works in non-component contexts (e.g., `effectScope`).
- **`LangChainPlugin`**: Vue plugin for app-level defaults — idiomatic Vue pattern.
- **`reactive` for queue**: The queue object is wrapped in `reactive()` so `entries` and `size` auto-unwrap in templates.
- **`watch` with `flush: "sync"`**: Used for thread ID synchronization, ensuring immediate reactivity.

#### Non-Idiomatic Patterns ⚠️

1. **Custom transport uses getters instead of `computed`**:

```122:135:libs/sdk-vue/src/stream.custom.ts
    get interrupts(): Interrupt<InterruptType>[] {
      void isLoading.value;
      return orchestrator.interrupts as Interrupt<InterruptType>[];
    },
    get messages() {
      if (!streamValues.value) return [];
      return ensureMessageInstances(orchestrator.messages);
    },
```

These getters are not cached — they recompute on every access. The LGP path uses `computed()`, which caches results. This inconsistency means custom transport users may experience unnecessary recomputation.

2. **Non-reactive queue in custom transport**: `queue.entries` and `queue.size` are plain static values (`[]` and `0`) instead of reactive refs. If the custom transport ever supports queuing, these won't update.

3. **`void version.value` pattern**: While technically correct for triggering Vue's dependency tracking, the `void version.value` pattern is unusual and may confuse contributors. A comment explaining the pattern would help.

#### Developer Experience

- **Good README** with sections on quick start, options, return values, typing, interrupts, branching, queuing, shared state, plugin, and custom transport.
- **Documentation bug**: `.value` used in template examples (see section 2.4).
- **Type-safe composable**: `useStream<MyState, { InterruptType: { question: string } }>()` provides full type inference.
- **`LangChainPlugin`**: Nice DX for setting defaults once at app level.

---

### 3.4 @langchain/angular

**Location:** `libs/sdk-angular/`

#### Idiomatic Patterns ✅

- **Signals**: Uses Angular's `signal`, `computed`, and `effect` — the current recommended reactive primitives.
- **`inject()` function**: `injectStream` uses Angular's `inject()` for DI, which is the modern pattern (no constructor injection needed).
- **`InjectionToken`**: `STREAM_INSTANCE` and `STREAM_DEFAULTS` follow Angular's token-based DI.
- **`makeEnvironmentProviders`**: `provideStreamDefaults()` returns `EnvironmentProviders`, which is the Angular v15+ pattern for app-level configuration.
- **Standalone components**: All examples use `standalone: true`.
- **`@Injectable()` base class**: `StreamService` provides a class-based alternative for services, following Angular's service pattern.
- **Naming**: `injectStream` follows Angular's `inject*` convention. `useStream` is kept as a deprecated alias for backward compatibility.

#### Non-Idiomatic Patterns ⚠️

1. **No RxJS integration**: Angular's ecosystem is heavily built around RxJS. The SDK uses Signals exclusively, with no option to get an Observable-based API. For Angular developers accustomed to `switchMap`, `takeUntil`, and other RxJS operators for stream management, this may feel limiting. Consider offering an `Observable`-based alternative or at least `toObservable()` adapters.

2. **Circular dependency** between `context.ts` and `index.ts`:
   - `context.ts` imports `useStream` from `index.ts` (line 15)
   - `index.ts` imports from `context.ts` (line 45)
   
   This works at runtime because `useStream` is only called inside `useFactory` (lazy evaluation), but it's a fragile structure that could break with bundler optimizations or tree-shaking.

3. **`STREAM_INSTANCE` typed as `any`**:

```41:43:libs/sdk-angular/src/context.ts
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const STREAM_INSTANCE = new InjectionToken<any>(
  "LANGCHAIN_STREAM_INSTANCE",
);
```

This loses type safety for anything injected through `provideStream`. A generic or a base interface would be better.

4. **`subagents` and `activeSubagents` as getters with `void subagentVersion()`**: These use `void subagentVersion()` for dependency tracking but return mutable `Map`/`Array` references. This means the getter triggers signal updates, but mutations to the returned Map won't be tracked. This is consistent with how the orchestrator works, but may surprise Angular developers expecting full signal reactivity.

#### Developer Experience

- **Excellent JSDoc**: `injectStream` has extensive JSDoc with multiple `@example` blocks covering `createDeepAgent`, `StateGraph`, typed interrupts, and subagent streaming. This is the best-documented entry point across all four packages.
- **`StreamService` base class**: Provides a familiar Angular pattern for developers who prefer class-based services.
- **Two-tier DI**: `provideStreamDefaults` for app-level config + `provideStream` for component-level sharing.
- **Migration path**: `useStream` kept as deprecated alias with clear migration note.

---

## 4. Consistency Matrix

| Aspect | React | Svelte | Vue | Angular |
|--------|-------|--------|-----|---------|
| **Entry function** | `useStream()` | `useStream()` | `useStream()` | `injectStream()` (+ deprecated `useStream`) |
| **Custom transport dispatch** | `useState` + conditional hooks | `"transport" in options` check | `"transport" in options` check | `"transport" in options` check |
| **Context/DI** | `useStreamContext()` (react-ui) | 4 functions (2 pairs) | `provideStream` + `useStreamContext` + plugin | `provideStream` + `provideStreamDefaults` + `injectStream()` no-arg |
| **`isLoading` (custom transport)** | ✅ from `StreamManager` | ✅ via `derived` store | ✅ via `shallowRef` subscription | ❌ **BUG**: hardcoded `false` |
| **Queue (custom transport)** | Stubbed (no queue) | Stubbed (writable stores) | Stubbed (static values) | Stubbed (signals) |
| **Message classes** | ❌ (plain `Message`) | ✅ (`BaseMessage`) | ✅ (`BaseMessage`) | ✅ (`BaseMessage`) |
| **`WithClassMessages` mapping** | In `types.tsx` | In `index.ts` | In `index.ts` | In `index.ts` |
| **Cleanup** | `useEffect` cleanup / `useSyncExternalStore` | `onDestroy` | `onScopeDispose` | `effect` `onCleanup` |
| **`any` usage** | In `useStream` overload impl | In `useStream` impl + context | In `useStream` impl + context | In `injectStream` impl + context |

---

## 5. Recommendations

### Critical (Bugs)

1. **Fix Angular `isLoading` in custom transport**: Sync `orchestrator.isLoading` into the `isLoading` signal via the subscription callback, matching Vue's implementation.

### High Priority (DX)

2. **Fix README documentation errors**: 
   - Change `import type { BaseMessage } from "langchain"` to `from "@langchain/core/messages"` in Svelte, Vue, and Angular READMEs.
   - Remove `.value` from Vue README template examples.

3. **Document custom transport limitations**: Add a clear section explaining which features are unavailable in custom transport mode (history, joinStream, queue, branchTree, isThreadLoading). Consider throwing descriptive errors when users try to access unavailable features.

4. **Unify Svelte context APIs**: Either deprecate one of the two pairs (`setStreamContext`/`getStreamContext` vs `provideStream`/`getStream`) or clearly document when each should be used.

### Medium Priority (Consistency)

5. **Extract shared `WithClassMessages<T>`**: Move the core type mapping to `@langchain/langgraph-sdk/ui` with framework-specific wrappers (e.g., `WithRef<T>` for Vue, `WithSignal<T>` for Angular).

6. **Align custom transport reactivity**: In Vue's custom transport, replace getters with `computed()` for consistency with the LGP path. In Svelte's custom transport, ensure `isLoading` is derived from the orchestrator (it already is, via `derived(version, () => orchestrator.isLoading)` — this is correct).

7. **Angular: Add RxJS helpers**: Consider providing `toObservable()` wrappers or an `ObservableStreamService` for developers who prefer RxJS patterns.

8. **Resolve Angular circular dependency**: Move `useStreamLGP` to a separate module that both `context.ts` and `index.ts` can import without cycles.

### Low Priority (Code Quality)

9. **Reduce `as any` casts**: Several packages use `options as any` in overload implementations. Consider a shared narrowing utility or intermediate types.

10. **React: Address conditional hooks pattern**: Document the limitation that transport mode is locked on first render, or restructure to use a single hook with an internal branching mechanism.

11. **React: Consider splitting `stream.lgp.tsx`**: At ~890 lines, this file handles too many concerns. Extract history management, reconnection logic, and branching into separate hooks/utilities.

12. **Vue: Add `// Dependency tracking` comments**: The `void version.value` pattern should be documented inline for contributors unfamiliar with this Vue technique.

---

## 6. Overall Assessment

| Dimension | Rating | Notes |
|-----------|--------|-------|
| **Type Safety** | ⭐⭐⭐⭐ | Strong generics, agent type inference, tool call typing. Weakened by `any` casts at boundaries. |
| **Framework Idioms** | ⭐⭐⭐⭐ | Vue and Angular follow framework patterns well. React uses `useSyncExternalStore` correctly. Svelte uses stores+fromStore bridge (adequate but not native Svelte 5). |
| **API Consistency** | ⭐⭐⭐ | Good consistency across LGP paths; significant gaps in custom transport paths. |
| **Documentation** | ⭐⭐⭐⭐ | Angular JSDoc is excellent. READMEs are comprehensive but have import/template errors. |
| **Error Handling** | ⭐⭐⭐ | Errors surfaced via `error` property. No custom error classes in framework packages (rely on SDK's `StreamError`). Context-missing throws are clear. |
| **Test Coverage** | ⭐⭐⭐⭐ | All packages have runtime tests and type tests. 20+ test components in Svelte/Angular. |
| **Developer Experience** | ⭐⭐⭐⭐ | Single entry point, strong typing, context sharing, multiple transport modes. Custom transport gaps and documentation errors are the main detractors. |

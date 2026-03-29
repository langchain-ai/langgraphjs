# Frontend Integration Strategy: Visibility-Aware Streaming & Rendering

## Executive Summary

This proposal outlines improvements to how our React, Vue, Svelte, and Angular
integration packages consume streaming data and render updates, with a focus on
**inactive tab optimization**. Today, all four framework adapters blindly push
every streaming event into the UI reactivity system regardless of whether the
user is actually looking at the page. By introducing a shared, framework-agnostic
**VisibilityManager** at the SDK layer and enhancing the existing throttle
pipeline, we can significantly reduce wasted CPU, memory churn, and battery
drain—especially on mobile devices.

---

## 1. Current Architecture

### 1.1 Shared Core (`@langchain/langgraph-sdk/ui`)

All four framework packages wrap the same engine:

| Component | Role |
|-----------|------|
| `StreamOrchestrator` | Manages lifecycle: submit, join, reconnect, queue drain, history |
| `StreamManager` | Owns stream state, event loop (`enqueue`), subscriber notification |
| `PendingRunsTracker` | Server-side run queue tracking |
| `MessageTupleManager` | Incremental message chunk management |
| `SubagentManager` | Subagent lifecycle and state |
| `FetchStreamTransport` | Custom backend HTTP+SSE transport |

### 1.2 Framework Adapters

| Package | Reactivity Mechanism | Subscribe Pattern |
|---------|---------------------|-------------------|
| `@langchain/react` | `useSyncExternalStore(stream.subscribe, stream.getSnapshot)` | External store |
| `@langchain/vue` | `shallowRef(version)` + `computed` + `watch` | Orchestrator `subscribe()` |
| `@langchain/svelte` | `writable(version)` + `derived` + `fromStore` | Orchestrator `subscribe()` |
| `@langchain/angular` | `signal(version)` + `computed` + `effect` | Orchestrator `subscribe()` |

### 1.3 Current Throttle Implementation

`StreamManager.subscribe()` applies a **trailing debounce** via `setTimeout`:

```typescript
// libs/sdk/src/ui/manager.ts
subscribe = (listener: () => void): (() => void) => {
  if (this.throttle === false) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  const timeoutMs = this.throttle === true ? 0 : this.throttle;
  let timeoutId: NodeJS.Timeout | number | undefined;
  const throttledListener = () => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => {
      clearTimeout(timeoutId);
      listener();
    }, timeoutMs);
  };
  this.listeners.add(throttledListener);
  return () => {
    clearTimeout(timeoutId);
    this.listeners.delete(throttledListener);
  };
};
```

**Key observations:**
- This is a **debounce** (trailing edge), not a true throttle—during rapid
  streaming, the listener fires only after events stop arriving for `timeoutMs`.
- `throttle: true` uses `setTimeout(fn, 0)`, collapsing updates to the next
  macrotask.
- There is **no awareness of page visibility** — the same rate applies whether
  the user is looking at the page or not.

### 1.4 What Happens in Inactive Tabs Today

When a user switches to another browser tab during an active LLM stream:

1. **The SSE/fetch stream continues consuming data** — the browser still receives
   bytes from the server and the async generator in `StreamManager.enqueue()`
   keeps iterating.
2. **Every event triggers `notifyListeners()`** — each update calls all framework
   subscribers.
3. **Framework reactivity fires** — React schedules re-renders, Vue triggers
   computed recalculations, Svelte stores update, Angular signals change.
4. **Browser throttles `setTimeout`** — Chrome throttles background tab timers to
   once per second (basic), budget-based after 10s, and once per minute after 5
   minutes ("intensive throttling" since Chrome 88).
5. **DOM updates are wasted** — the browser does not paint invisible tabs, so all
   DOM mutations are pure overhead.
6. **`requestAnimationFrame` stops entirely** — any rAF-based animations halt.

The net effect: we do significant JavaScript work (state diffing, message
processing, reactivity graph traversal) that produces no user-visible result.
When the user returns, there may be a burst of queued timer callbacks and a
sudden re-render avalanche.

---

## 2. How Other Libraries Handle This

### 2.1 TanStack Query

TanStack Query has a dedicated **`FocusManager`** singleton:

```typescript
// Simplified from TanStack Query source
class FocusManager extends Subscribable {
  #focused?: boolean;
  #setup: SetupFn;

  constructor() {
    super();
    this.#setup = (onFocus) => {
      if (typeof window !== 'undefined' && window.addEventListener) {
        const listener = () => onFocus();
        window.addEventListener('visibilitychange', listener, false);
        return () => window.removeEventListener('visibilitychange', listener);
      }
    };
  }

  isFocused(): boolean {
    if (typeof this.#focused === 'boolean') return this.#focused;
    return globalThis.document?.visibilityState !== 'hidden';
  }
}
```

Key behaviors:
- **`refetchOnWindowFocus`** (default: `true`): automatically re-fetches stale
  data when the window regains visibility.
- **`refetchIntervalInBackground`**: opt-in flag to continue polling when hidden.
- **Lazy setup**: event listener is only attached when the first subscriber
  exists; cleaned up when the last one unsubscribes.
- Uses **`visibilitychange`** exclusively (not `focus`) to avoid false positives
  from DevTools, iframes, and dialog interactions.

### 2.2 SWR (Vercel)

SWR provides:
- **`revalidateOnFocus`** (default: `true`): re-fetches stale data on tab return.
- **`refreshWhenHidden`** (default: `false`): disables polling when tab is
  hidden.
- **`refreshWhenOffline`** (default: `false`): companion for network state.
- Recent PR discussions propose dropping `focus` event entirely in favor of
  `visibilitychange` to reduce spurious re-validations.

### 2.3 Vercel AI SDK

- **`resume: true`** option on `useChat`: reconnects to active server streams
  after page reload / tab closure.
- Uses a Redis-backed pub/sub for stream persistence.
- Does **not** optimize rendering in inactive tabs—focus is on **durability**
  rather than performance.

### 2.4 React 19.2 `<Activity>` Component

React 19.2 introduced `<Activity mode="visible" | "hidden">`:
- `hidden` mode: applies `display: none`, unmounts effects, defers updates to
  idle time.
- State and DOM are preserved (unlike conditional rendering).
- Designed for tab-based UIs, not browser-level visibility.
- Relevant as a **complementary** mechanism that users could layer on top.

### 2.5 Browser-Level Constraints

| Mechanism | Inactive Tab Behavior |
|-----------|----------------------|
| `setTimeout` / `setInterval` | Throttled to 1/s, then budget-based, then 1/min after 5 min |
| `requestAnimationFrame` | Completely stopped |
| `fetch` / SSE streams | Continue running (not throttled) |
| Web Workers | Not throttled |
| DOM painting | Stopped entirely |

This means: **our async generators and event processing continue at full speed,
but all downstream UI work is wasted** since the browser will not paint anyway.

---

## 3. Proposed Changes

### 3.1 Introduce `VisibilityManager` (SDK Layer)

Create a framework-agnostic `VisibilityManager` singleton in
`@langchain/langgraph-sdk/ui`, modeled after TanStack Query's `FocusManager`:

```typescript
// libs/sdk/src/ui/visibility.ts

type Listener = (visible: boolean) => void;
type SetupFn = (
  setVisible: (visible?: boolean) => void,
) => (() => void) | undefined;

export class VisibilityManager {
  #visible?: boolean;
  #cleanup?: () => void;
  #listeners = new Set<Listener>();
  #setup: SetupFn;

  constructor() {
    this.#setup = (onVisibilityChange) => {
      if (typeof window !== "undefined" && window.addEventListener) {
        const listener = () => onVisibilityChange();
        window.addEventListener("visibilitychange", listener, false);
        return () =>
          window.removeEventListener("visibilitychange", listener);
      }
      return undefined;
    };
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    if (this.#listeners.size === 1) {
      this.#cleanup = this.#setup((visible) => {
        if (typeof visible === "boolean") {
          this.setVisible(visible);
        } else {
          this.#notify();
        }
      })!;
    }
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0) {
        this.#cleanup?.();
        this.#cleanup = undefined;
      }
    };
  }

  setEventListener(setup: SetupFn): void {
    this.#setup = setup;
    this.#cleanup?.();
    if (this.#listeners.size > 0) {
      this.#cleanup = setup((visible) => {
        if (typeof visible === "boolean") {
          this.setVisible(visible);
        } else {
          this.#notify();
        }
      })!;
    }
  }

  setVisible(visible: boolean): void {
    if (this.#visible !== visible) {
      this.#visible = visible;
      this.#notify();
    }
  }

  isVisible(): boolean {
    if (typeof this.#visible === "boolean") return this.#visible;
    return globalThis.document?.visibilityState !== "hidden";
  }

  #notify(): void {
    const visible = this.isVisible();
    for (const listener of this.#listeners) {
      listener(visible);
    }
  }
}

export const visibilityManager = new VisibilityManager();
```

**Why a singleton?** Same rationale as TanStack Query: one `visibilitychange`
listener shared across all stream instances on the page, with lazy setup/teardown.

**Why `visibilitychange` only?** The `focus`/`blur` events trigger on DevTools
interaction, iframe focus, file dialogs, and alert boxes—all false positives that
would disrupt an active LLM stream. `visibilitychange` fires only when the page
truly becomes hidden/visible.

**Why allow `setEventListener`?** Enables React Native, Electron, and other
non-browser environments to provide custom visibility detection (e.g.,
`AppState.addEventListener("change", ...)` in React Native).

### 3.2 Visibility-Aware Subscriber Notification

Enhance `StreamManager.subscribe()` to support visibility-aware throttling:

```typescript
// Enhanced subscribe in StreamManager

subscribe = (listener: () => void): (() => void) => {
  if (this.throttle === false && !this.pauseWhenHidden) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  const timeoutMs =
    this.throttle === true ? 0 : this.throttle === false ? 0 : this.throttle;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let pendingUpdate = false;

  const flush = () => {
    clearTimeout(timeoutId);
    timeoutId = undefined;
    pendingUpdate = false;
    listener();
  };

  const throttledListener = () => {
    if (this.pauseWhenHidden && !visibilityManager.isVisible()) {
      pendingUpdate = true;
      return;
    }

    if (this.throttle === false) {
      listener();
      return;
    }

    clearTimeout(timeoutId);
    timeoutId = setTimeout(flush, timeoutMs);
  };

  let visibilityUnsub: (() => void) | undefined;
  if (this.pauseWhenHidden) {
    visibilityUnsub = visibilityManager.subscribe((visible) => {
      if (visible && pendingUpdate) {
        flush();
      }
    });
  }

  this.listeners.add(throttledListener);
  return () => {
    clearTimeout(timeoutId);
    this.listeners.delete(throttledListener);
    visibilityUnsub?.();
  };
};
```

**Behavior:**
- When `pauseWhenHidden` is true and the tab is hidden, subscriber notifications
  are **suppressed** and a `pendingUpdate` flag is set.
- When the tab becomes visible, if there were pending updates, a **single flush**
  is triggered immediately, delivering the latest state.
- The stream itself continues consuming events (maintaining the SSE connection
  and updating internal state)—only UI notifications are paused.
- This is safe because `StreamManager` state is always the latest snapshot; the
  UI just needs to read it once on visibility return.

### 3.3 New `pauseRenderingWhenHidden` Option

Add a user-facing option to control this behavior:

```typescript
// Addition to UseStreamBaseOptions in libs/sdk/src/ui/types.ts

/**
 * Pause UI notifications when the browser tab is hidden.
 *
 * When enabled, stream events are still consumed and internal state is
 * updated, but framework-level notifications (React re-renders, Vue
 * computed updates, Svelte store updates, Angular signal updates) are
 * suppressed while the page is not visible.
 *
 * When the page becomes visible again, a single notification is fired
 * to bring the UI up to date with the latest state.
 *
 * This reduces CPU usage and battery drain when users switch to other
 * tabs during long-running LLM generations.
 *
 * Set to `false` to always notify subscribers regardless of visibility.
 *
 * @default true
 */
pauseRenderingWhenHidden?: boolean;
```

### 3.4 Enhance Throttle to True Throttle (Optional Enhancement)

The current "throttle" is actually a **trailing debounce**: during sustained
streaming, the listener fires only after the burst ends, which can cause the UI
to feel unresponsive during long streams. Consider offering a true
leading-edge throttle:

```typescript
// True throttle: fires immediately, then ignores for `interval` ms
subscribe = (listener: () => void): (() => void) => {
  const interval = resolveThrottleMs(this.throttle);
  if (interval === null) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  let lastFired = 0;
  let trailingTimeout: ReturnType<typeof setTimeout> | undefined;
  let pendingUpdate = false;

  const fire = () => {
    lastFired = Date.now();
    clearTimeout(trailingTimeout);
    trailingTimeout = undefined;
    pendingUpdate = false;
    listener();
  };

  const throttledListener = () => {
    if (this.pauseWhenHidden && !visibilityManager.isVisible()) {
      pendingUpdate = true;
      return;
    }

    const now = Date.now();
    const elapsed = now - lastFired;

    if (elapsed >= interval) {
      fire();
    } else {
      pendingUpdate = true;
      if (!trailingTimeout) {
        trailingTimeout = setTimeout(fire, interval - elapsed);
      }
    }
  };

  // ... visibility subscription as above ...
};
```

This ensures the UI gets at least one update per throttle interval during
streaming, providing progressive rendering rather than delayed batch rendering.

### 3.5 `onReturnToForeground` Callback

Provide a lifecycle hook for users who want custom behavior when the tab becomes
visible again:

```typescript
/**
 * Called when the browser tab returns to the foreground after being hidden.
 *
 * Useful for refreshing stale data, re-syncing thread state, or showing
 * a "you missed updates" indicator.
 *
 * Only called if the stream had pending updates while hidden.
 */
onReturnToForeground?: (context: {
  /** Number of stream events received while hidden */
  missedEventCount: number;
  /** Duration the tab was hidden in milliseconds */
  hiddenDurationMs: number;
  /** Whether the stream is still actively loading */
  isLoading: boolean;
}) => void;
```

### 3.6 Expose `visibilityManager` for Advanced Use Cases

Export the `visibilityManager` singleton so users can:

- Query visibility state in their own code
- Override detection for non-browser environments
- Subscribe to visibility changes for custom side effects

```typescript
// libs/sdk/src/ui/index.ts
export { visibilityManager, VisibilityManager } from "./visibility.js";
```

---

## 4. Implementation Plan

### Phase 1: Core Infrastructure

**Components to change:** `libs/sdk/src/ui/`

1. Create `visibility.ts` with `VisibilityManager` class and singleton.
2. Add `pauseRenderingWhenHidden` to `StreamManagerOptions`.
3. Modify `StreamManager.subscribe()` to integrate visibility-aware notification
   suppression.
4. Add `onReturnToForeground` callback support.
5. Update `StreamOrchestrator` and `CustomStreamOrchestrator` to pass through the
   new option.
6. Export new types and the singleton from `@langchain/langgraph-sdk/ui`.
7. Add unit tests for `VisibilityManager`.
8. Add unit tests for visibility-aware subscribe behavior.

### Phase 2: Framework Adapter Updates

**Components to change:** `libs/sdk-react/`, `libs/sdk-vue/`, `libs/sdk-svelte/`,
`libs/sdk-angular/`

For each framework:
1. Pass through `pauseRenderingWhenHidden` option from `useStream` / `injectStream`.
2. Update documentation/README.
3. Add integration tests verifying:
   - Updates are suppressed when `document.visibilityState === "hidden"`.
   - A flush occurs when visibility returns.
   - Stream data is not lost (internal state stays current).

The framework adapters require minimal changes since the visibility logic lives
in the shared `StreamManager.subscribe()` layer.

### Phase 3: Enhanced Throttle

**Components to change:** `libs/sdk/src/ui/manager.ts`

1. Rename the existing debounce behavior or introduce a separate `debounce`
   option.
2. Implement true leading-edge throttle with trailing flush.
3. Consider a `throttle: { type: "throttle" | "debounce", ms: number }` object
   form for full control (with backward-compatible `number | boolean` shorthand).

### Phase 4: Documentation & Examples

1. Add a concept page: "Optimizing Frontend Performance".
2. Update each framework's README with visibility-related options.
3. Add an example showing `onReturnToForeground` with a "catching up..." indicator.

---

## 5. API Surface Summary

### New Options on `useStream` / `injectStream`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `pauseRenderingWhenHidden` | `boolean` | `true` | Suppress UI notifications when tab is hidden |
| `onReturnToForeground` | `(ctx) => void` | — | Callback when tab returns to foreground |

### New Exports from `@langchain/langgraph-sdk/ui`

| Export | Type | Description |
|--------|------|-------------|
| `visibilityManager` | `VisibilityManager` | Singleton for visibility state |
| `VisibilityManager` | class | For custom instances / testing |

### Modified Behavior

| Scenario | Before | After (`pauseRenderingWhenHidden: true`) |
|----------|--------|-------------------------------------------|
| Tab hidden, stream active | Full event processing + subscriber notification | Full event processing, **no** subscriber notification |
| Tab returns after hidden | Normal rendering continues | Single flush notification with latest state |
| `throttle: true` + hidden | Debounced updates (wasted in hidden tab) | Updates suppressed entirely |
| `throttle: 50` + hidden | 50ms debounced updates (wasted) | Updates suppressed entirely |

---

## 6. Risks and Mitigations

### Risk: Users depend on side effects in subscriber callbacks

**Mitigation:** Default `pauseRenderingWhenHidden` to `true` but document clearly.
Users who run critical logic in `onCustomEvent` or `onUpdate` callbacks (which
fire inside `StreamManager.enqueue`, not in subscriber notifications) are
unaffected—those callbacks are decoupled from the notification system.

### Risk: SSR / React Native environments have no `document`

**Mitigation:** `VisibilityManager` gracefully falls back to "always visible" when
`document` is not available. `setEventListener` allows environments to provide
custom detection.

### Risk: Large state delta on return to foreground

**Mitigation:** Since `StreamManager` always maintains the latest state internally,
the flush on return is a single snapshot read—there is no backlog of intermediate
states to replay. The UI simply renders the current state.

### Risk: Breaking change for `throttle` behavior

**Mitigation:** Phase 3 (enhanced throttle) should be opt-in. Keep existing
`number | boolean` semantics unchanged; introduce the object form as a new
capability.

---

## 7. Impact Analysis

### Performance Wins

- **CPU:** Eliminates all framework reactivity work (diffing, computed
  recalculation, store derivation) while tab is hidden.
- **Memory:** Reduces intermediate object allocation from suppressed renders.
- **Battery:** Significant on mobile devices where background tabs run with
  constrained power budgets.
- **Main thread:** Prevents timer callback storms when returning to the tab.

### Compatibility

- **React `useSyncExternalStore`:** Fully compatible. The store version still
  increments internally; getSnapshot returns the latest version. The suppression
  happens at the listener level, so React simply doesn't re-render until the
  flush.
- **Vue `computed` / `watch`:** Version ref doesn't increment while hidden, so
  computed properties don't recompute. On flush, a single version bump triggers
  one recomputation with latest data.
- **Svelte `derived` / `fromStore`:** Same pattern—derived stores recalculate
  once on flush.
- **Angular `signal` / `effect`:** Signal value doesn't change while hidden;
  single update on flush.

### What This Does NOT Change

- **Stream connection:** The SSE/HTTP stream stays open. Server-side, the LLM
  generation continues uninterrupted.
- **Internal state:** `StreamManager` state (`values`, `messages`, `error`,
  `isLoading`) is always up to date.
- **Callbacks:** `onCreated`, `onFinish`, `onError`, `onCustomEvent`,
  `onToolEvent`, etc. fire normally regardless of visibility—they execute inside
  `enqueue()`, not in subscriber notifications.
- **Reconnect:** `reconnectOnMount` / `sessionStorage` behavior is unchanged.

---

## 8. Prior Art Comparison

| Library | Visibility-Aware | Mechanism | Default |
|---------|-----------------|-----------|---------|
| **TanStack Query** | Yes | `FocusManager` singleton, `refetchOnWindowFocus` | Refetch on focus |
| **SWR** | Yes | `revalidateOnFocus`, `refreshWhenHidden` | Re-validate on focus, no refresh when hidden |
| **Vercel AI SDK** | No | — | No visibility optimization |
| **LangGraph (current)** | No | — | Full processing always |
| **LangGraph (proposed)** | Yes | `VisibilityManager` singleton, `pauseRenderingWhenHidden` | Pause rendering when hidden |

Our approach is **more targeted** than TanStack Query or SWR: we don't refetch on
return (the stream has been keeping state current), we just **flush the latest
snapshot**. This is the right model for streaming workloads where the server push
is continuous and the data is always fresh—we just need to stop wasting CPU on
invisible renders.

---

## 9. Future Considerations

### 9.1 `IntersectionObserver`-Based Rendering

For chat UIs with long message lists, we could provide utilities to skip
rendering messages that are scrolled out of the viewport. This is orthogonal to
tab visibility but follows the same principle: don't render what the user can't
see.

### 9.2 React 19.2 `<Activity>` Integration

When React 19.2 adoption is widespread, we could provide a `<StreamActivity>`
wrapper that automatically sets `mode="hidden"` when the browser tab is hidden,
combining browser-level visibility with React's built-in deferred rendering.

### 9.3 Adaptive Throttle

Dynamically adjust throttle rate based on:
- Stream velocity (tokens/second)
- Device capabilities (`navigator.deviceMemory`, `navigator.hardwareConcurrency`)
- Battery status (`navigator.getBattery()`)

### 9.4 Web Worker Stream Processing

Move `StreamManager.enqueue()` event processing to a Web Worker to avoid main
thread contention entirely. Web Workers are not subject to background tab
throttling, so event processing would continue at full speed regardless of
visibility. Only serialized state snapshots would be posted back to the main
thread on visibility return.

### 9.5 Network-Aware Behavior

Companion `OnlineManager` (like TanStack Query) that pauses reconnect attempts
when offline and triggers reconnection on network return, paired with
`navigator.connection` API for adaptive streaming quality.

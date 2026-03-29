# Frontend Integration Strategy: Performant Agent UX

## Executive Summary

This proposal outlines improvements to how our React, Vue, Svelte, and Angular
integration packages consume streaming data and render updates. It addresses
three categories:

1. **Browser state awareness** — stop wasting CPU on invisible renders when tabs
   are inactive, the network drops, or the page is frozen.
2. **Streaming rendering performance** — adopt industry best practices from
   ChatGPT, Chrome's LLM rendering guide, and modern framework primitives to
   make token streaming feel fast on any device.
3. **Developer experience** — reduce boilerplate, close parity gaps between
   framework packages, and provide the primitives developers need to build
   production-quality agent UIs without reinventing common patterns.

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
- There is **no awareness of page visibility, network state, or page lifecycle
  events** — the same rate applies regardless of whether the user can see the
  output.

### 1.4 What Happens in Inactive Tabs Today

When a user switches to another browser tab during an active LLM stream:

1. **The SSE/fetch stream continues consuming data** — the browser still receives
   bytes from the server and the async generator in `StreamManager.enqueue()`
   keeps iterating.
2. **Every event triggers `notifyListeners()`** — each update calls all framework
   subscribers.
3. **Framework reactivity fires** — React schedules re-renders, Vue triggers
   computed recalculations, Svelte stores update, Angular signals change.
4. **Browser throttles timers** — Chrome throttles background tab `setTimeout` to
   once per second (basic), budget-based after 10s, and once per minute after 5
   minutes ("intensive throttling" since Chrome 88).
5. **DOM updates are wasted** — the browser does not paint invisible tabs, so all
   DOM mutations are pure overhead.
6. **`requestAnimationFrame` stops entirely** — any rAF-based animations and
   smooth-scroll logic halt.
7. **Timer callback storms on return** — queued `setTimeout` callbacks fire in a
   burst when the tab returns, potentially causing a spike of re-renders.

### 1.5 Other Gaps in Current Frontend Packages

Analysis of the codebase and example apps reveals additional issues beyond
visibility:

| Area | Current State | Impact |
|------|--------------|--------|
| **Optimistic updates** | Manual, identical boilerplate repeated in all 4 framework examples | DX friction |
| **Message normalization** | Apps implement custom reducers to map messages → UI rows (tool results, reasoning, text) | Duplicated effort |
| **Loading granularity** | `isLoading` + `isThreadLoading` only; no "thinking" vs "generating" phase | Limited UX control |
| **Error recovery** | No automatic retry; manual `joinStream` + `reconnectOnMount` only | Fragile experience |
| **Connection health** | Not exposed at UI layer; SSE reconnect is internal to the client | No offline/reconnect UI |
| **Auto-scroll** | Entirely app-level concern; no SDK guidance or utilities | Every app reinvents it |
| **Custom transport parity** | `useStreamCustom` lacks `toolProgress`, history, reconnect, queue | Feature gap |
| **Streaming markdown** | No SDK-level guidance; apps struggle with half-open fences, innerHTML perf | Common pitfall |
| **Package fragmentation** | `@langchain/react` vs `@langchain/langgraph-sdk/react` expose overlapping APIs | Developer confusion |

---

## 2. How Other Libraries Handle Browser State

### 2.1 TanStack Query — FocusManager + OnlineManager

TanStack Query has two dedicated manager singletons:

**FocusManager** — tracks page visibility:

```typescript
class FocusManager extends Subscribable {
  #focused?: boolean;
  #setup: SetupFn;

  constructor() {
    super();
    this.#setup = (onFocus) => {
      if (typeof window !== "undefined" && window.addEventListener) {
        const listener = () => onFocus();
        window.addEventListener("visibilitychange", listener, false);
        return () => window.removeEventListener("visibilitychange", listener);
      }
    };
  }

  isFocused(): boolean {
    if (typeof this.#focused === "boolean") return this.#focused;
    return globalThis.document?.visibilityState !== "hidden";
  }
}
export const focusManager = new FocusManager();
```

**OnlineManager** — tracks network state:

```typescript
class OnlineManager extends Subscribable {
  #online = true;
  #setup: SetupFn;

  constructor() {
    super();
    this.#setup = (onOnline) => {
      if (typeof window !== "undefined" && window.addEventListener) {
        window.addEventListener("online", () => onOnline(true), false);
        window.addEventListener("offline", () => onOnline(false), false);
        return () => { /* cleanup */ };
      }
    };
  }

  isOnline(): boolean { return this.#online; }
}
export const onlineManager = new OnlineManager();
```

Key behaviors:
- **`refetchOnWindowFocus`** (default: `true`): automatically re-fetches stale
  data when the window regains visibility.
- **`refetchIntervalInBackground`**: opt-in flag to continue polling when hidden.
- **Lazy setup**: event listeners attach on first subscriber, detach on last
  unsubscribe.
- Uses **`visibilitychange`** exclusively (not `focus`) to avoid false positives
  from DevTools, iframes, and dialog interactions.
- Network and focus managers are **independent, composable concerns** — a
  pattern we should follow.

### 2.2 SWR (Vercel)

SWR provides a complementary set of visibility/network controls:
- **`revalidateOnFocus`** (default: `true`): re-fetches stale data on tab return.
- **`refreshWhenHidden`** (default: `false`): prevents polling when the tab is
  hidden.
- **`refreshWhenOffline`** (default: `false`): prevents fetching when offline.
- Recent discussions (PR #2672) propose switching from `focus` to
  `visibilitychange` exclusively to reduce spurious revalidations from DevTools,
  iframe, and file dialog interactions.
- **`onErrorRetry`** continues working on inactive tabs even without focus
  revalidation (PR #2848).

### 2.3 Apollo Client — `skipPollAttempt`

Apollo Client 3.9 introduced **`skipPollAttempt`**, a callback that controls
whether polling should proceed:

```typescript
const client = new ApolloClient({
  defaultOptions: {
    watchQuery: {
      skipPollAttempt: () => document.hidden,
    },
  },
});
```

This is a **per-query, imperative check** rather than a centralized manager.
It works for polling-based use cases but doesn't address WebSocket subscriptions
or streaming. Our centralized `VisibilityManager` approach is more appropriate
for streaming workloads.

### 2.4 Socket.IO — Connection Lifecycle Under Visibility

Socket.IO faces a critical problem with background tabs: browser timer throttling
causes heartbeat detection to fail, leading to ping timeouts and disconnections
after 30 seconds to 5 minutes. Key lessons:

- **Timer-based heartbeats are unreliable in hidden tabs** — Chrome's intensive
  throttling reduces `setTimeout` to once per minute after 5 minutes.
- **Buffered events create reconnection spikes** — events emitted while
  disconnected queue up and fire in bursts on reconnect.
- **Workaround patterns**: check `socket.connected` before emitting, use volatile
  events (not buffered), clear send buffer on reconnect.
- **Relevance to LangGraph**: our SSE-based streams don't use heartbeats (HTTP
  keeps the connection alive), but the timer throttling affects our
  `StreamManager.subscribe()` debounce and the reconnect patterns built on
  `sessionStorage`.

### 2.5 RxJS — Operator Patterns for Stream Management

RxJS provides a vocabulary of time-based operators that maps to our throttle
needs:

| Operator | Behavior | Analogy in Our System |
|----------|----------|-----------------------|
| `throttleTime` | Emits first value, ignores for duration | True throttle (leading edge) |
| `auditTime` | Ignores during duration, emits last value | Our current "throttle" (trailing edge) |
| `debounceTime` | Waits for silence, then emits last value | Our current behavior when `timeoutMs > 0` |
| `bufferTime` | Collects all values into arrays per window | Token buffering pattern |
| `sampleTime` | Emits most recent value at regular intervals | rAF-aligned rendering |

Our current "throttle" is actually an **audit/debounce hybrid**. The RxJS
taxonomy clarifies that what we need for streaming UIs is a **leading-edge
throttle with trailing flush** (`throttleTime` with `{ leading: true, trailing:
true }`).

### 2.6 Vercel AI SDK — `experimental_throttle` + Resume

- **`experimental_throttle: 50`** on `useChat`: throttles UI updates to 50ms
  intervals during streaming. Uses the `throttleit` npm package. Known issue:
  can cause `onFinish` to fire before all data is rendered.
- **`resume: true`**: reconnects to active streams after page reload via
  Redis-backed pub/sub. Critically, **abort breaks resumable streams** — a
  trade-off we've avoided with `streamResumable` + `onDisconnect: "continue"`.
- **No visibility optimization** — focus is on durability, not rendering perf.

### 2.7 React 19.2 `<Activity>` Component

React 19.2 introduced `<Activity mode="visible" | "hidden">`:
- `hidden` mode: applies `display: none`, unmounts effects, **defers all updates
  until idle time**.
- State and DOM are preserved (unlike conditional rendering).
- Designed for in-app tab interfaces, but the deferred-update concept applies
  to browser-level visibility as well.

### 2.8 Solid.js — Fine-Grained Reactivity + Transitions

Solid.js offers relevant patterns:
- **`createResource`**: integrated loading/error/refreshing states with distinct
  signals (no re-render of components that don't read loading state).
- **`useTransition`**: batches async updates in a transaction, deferring commit
  until all async processes complete — prevents Suspense fallback flicker.
- **`<Loading>` vs `<Suspense>`**: `<Loading>` shows stale content with a
  `pending` flag on updates (like our optimistic patterns); `<Suspense>` shows a
  fallback every time.

### 2.9 Qwik — `useVisibleTask$()` + IntersectionObserver

Qwik's `useVisibleTask$()` executes code only when a component becomes visible
in the viewport:
- Default strategy uses **`IntersectionObserver`** — code runs only when the
  element scrolls into view.
- Alternative strategies: `document-ready`, `document-idle`
  (`requestIdleCallback`).
- **Relevance**: for long chat message lists, executing rendering logic only for
  visible messages is the same principle as our proposed
  `IntersectionObserver`-based optimization.

### 2.10 Browser Page Lifecycle API

Beyond `visibilitychange`, the full Page Lifecycle API defines:

| State | JS Runs? | Timer Behavior | Relevance |
|-------|----------|----------------|-----------|
| **Active** | Yes | Normal | Normal operation |
| **Passive** | Yes | Normal | Window visible but not focused |
| **Hidden** | Yes | Throttled (1/s → 1/min) | Our primary optimization target |
| **Frozen** | **No** | Suspended | Must handle gracefully (bfcache) |
| **Discarded** | N/A | N/A | Page removed from memory |

The `freeze` / `resume` events are important: when a page is frozen (e.g., by
Chrome to save resources, or entering bfcache), all JS execution stops. Our
`VisibilityManager` should handle `freeze` to ensure clean state, and `resume`
to trigger reconnection if the stream died while frozen.

### 2.11 Chrome's Best Practices for Rendering LLM Responses

Google published official guidance (January 2025) for rendering streamed LLM
responses:

1. **Don't use `textContent +=` or `innerText +=`** — these remove all children
   and rebuild the text node on every chunk, creating O(n²) work.
2. **Use `append()` or `insertAdjacentText()`** — these preserve existing DOM
   and only add the new chunk.
3. **Use a streaming Markdown parser** (e.g., `streaming-markdown`) that
   calls `appendChild()` internally rather than replacing `innerHTML`.
4. **Sanitize accumulated output** (not individual chunks) with DOMPurify to
   prevent prompt injection attacks.

### 2.12 ChatGPT / Industry Streaming Patterns

Analysis of how ChatGPT and other chat UIs achieve smooth streaming:

1. **Token buffering in refs**: collect chunks in a `useRef` / mutable variable
   without triggering re-renders.
2. **Batch state updates at 30-50ms intervals**: humans cannot perceive the
   difference between per-token and 50ms-batched updates, but the rendering cost
   is dramatically lower.
3. **rAF-aligned rendering**: schedule state updates via `requestAnimationFrame`
   to sync with the browser's paint cycle.
4. **Character-level animation**: decouple network streaming (chunk-based) from
   visual rendering (character-based at 5-20ms per character) for smooth typing
   animations.
5. **List virtualization**: for sessions with hundreds of messages, render only
   visible messages using `react-window`, `react-virtuoso`, or TanStack Virtual.
6. **`content-visibility: auto`**: CSS property that tells the browser to skip
   layout/paint for off-screen elements, achieving up to 7x rendering
   performance improvement.

### 2.13 Summary: Browser State Handling Comparison

| Library | Visibility | Network | Freeze/Resume | Throttle | Default Behavior |
|---------|-----------|---------|----------------|----------|-----------------|
| **TanStack Query** | `FocusManager` singleton | `OnlineManager` singleton | N/A | N/A (refetch-based) | Refetch on focus |
| **SWR** | `revalidateOnFocus` | `refreshWhenOffline` | N/A | N/A | Revalidate on focus |
| **Apollo Client** | `skipPollAttempt` callback | N/A | N/A | N/A | Caller-managed |
| **Socket.IO** | N/A (heartbeat fails) | Reconnect with backoff | N/A | N/A | Auto-reconnect |
| **Vercel AI SDK** | None | Resume streams | None | `experimental_throttle` | No optimization |
| **LangGraph (current)** | None | `reconnectOnMount` | None | Trailing debounce | Full processing always |
| **LangGraph (proposed)** | `VisibilityManager` | `OnlineManager` | `freeze`/`resume` aware | Leading throttle + debounce | Pause rendering when hidden |

---

## 3. Proposed Changes

### Area A: Browser State Awareness

#### A.1 Introduce `VisibilityManager` (SDK Layer)

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
        const visListener = () => onVisibilityChange();
        window.addEventListener("visibilitychange", visListener, false);

        // Also handle freeze/resume for bfcache and resource management
        const freezeListener = () => onVisibilityChange(false);
        const resumeListener = () => onVisibilityChange(true);
        document.addEventListener("freeze", freezeListener);
        document.addEventListener("resume", resumeListener);

        return () => {
          window.removeEventListener("visibilitychange", visListener);
          document.removeEventListener("freeze", freezeListener);
          document.removeEventListener("resume", resumeListener);
        };
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

**Design decisions:**
- **Singleton with lazy setup/teardown**: one `visibilitychange` listener shared
  across all stream instances, attached on first subscriber, removed on last.
- **`visibilitychange` only (not `focus`)**: avoids false positives from DevTools,
  iframes, file dialogs, and alert boxes that would disrupt active streams.
- **`freeze`/`resume` awareness**: handles the Page Lifecycle API's frozen state
  (bfcache, Chrome resource management) gracefully.
- **`setEventListener()` API**: enables React Native (`AppState`), Electron
  (`browserWindow.on('show'/'hide')`), and other non-browser environments.

#### A.2 Introduce `OnlineManager` (SDK Layer)

Companion to `VisibilityManager`, tracking network connectivity:

```typescript
// libs/sdk/src/ui/online.ts

export class OnlineManager {
  #online = true;
  #cleanup?: () => void;
  #listeners = new Set<(online: boolean) => void>();
  #setup: SetupFn;

  constructor() {
    this.#setup = (onOnline) => {
      if (typeof window !== "undefined" && window.addEventListener) {
        const onlineHandler = () => onOnline(true);
        const offlineHandler = () => onOnline(false);
        window.addEventListener("online", onlineHandler, false);
        window.addEventListener("offline", offlineHandler, false);
        return () => {
          window.removeEventListener("online", onlineHandler);
          window.removeEventListener("offline", offlineHandler);
        };
      }
      return undefined;
    };
  }

  // subscribe, setOnline, isOnline — same pattern as VisibilityManager
}

export const onlineManager = new OnlineManager();
```

**Use in StreamOrchestrator:**
- Expose `stream.isOnline` for UI connection indicators.
- On `offline → online` transition, optionally trigger `tryReconnect()` if
  there's a stored run to rejoin.
- Suppress reconnect/history-fetch attempts while offline to avoid error noise.

#### A.3 Visibility-Aware Subscriber Notification

Enhance `StreamManager.subscribe()` with visibility-aware notification
suppression:

```typescript
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
  fires immediately, delivering the latest state.
- The stream itself continues consuming events — only UI notifications are paused.
- Safe because `StreamManager` state is always the latest snapshot.

#### A.4 New Options

```typescript
// Additions to UseStreamOptions in libs/sdk/src/ui/types.ts

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
 * @default true
 */
pauseRenderingWhenHidden?: boolean;

/**
 * Called when the browser tab returns to the foreground after being hidden.
 *
 * Useful for refreshing stale data, re-syncing thread state, or showing
 * a "catching up" indicator.
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

---

### Area B: Streaming Rendering Performance

#### B.1 Enhance Throttle to True Leading-Edge Throttle

The current "throttle" is a trailing debounce: during sustained streaming, the
listener fires only after events stop arriving. This causes the UI to feel
unresponsive during long streams. We should offer a true leading-edge throttle
that fires immediately and then rate-limits, following the RxJS `throttleTime`
pattern with both leading and trailing edges:

```typescript
subscribe = (listener: () => void): (() => void) => {
  const interval = resolveThrottleMs(this.throttle);
  if (interval === null && !this.pauseWhenHidden) {
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
    // Visibility gate
    if (this.pauseWhenHidden && !visibilityManager.isVisible()) {
      pendingUpdate = true;
      return;
    }

    // No throttle, just fire
    if (interval === null) {
      listener();
      return;
    }

    const now = Date.now();
    const elapsed = now - lastFired;

    if (elapsed >= interval) {
      // Leading edge: fire immediately
      fire();
    } else {
      // Within throttle window: schedule trailing edge
      pendingUpdate = true;
      if (!trailingTimeout) {
        trailingTimeout = setTimeout(fire, interval - elapsed);
      }
    }
  };

  // ... visibility subscription for flush-on-return ...
};
```

This ensures:
- **Immediate first update** when streaming starts (leading edge).
- **Regular updates** at `interval` ms during streaming.
- **Final update** when streaming ends (trailing edge).
- **No wasted updates** when hidden.

Compared to the Vercel AI SDK's `experimental_throttle: 50` (which uses a simple
trailing throttle and has a known bug where `onFinish` fires before rendering
completes), our approach guarantees the trailing edge fires, keeping callbacks
in sync with rendered state.

#### B.2 `requestAnimationFrame`-Aligned Rendering Mode

For the smoothest possible streaming experience, provide an rAF-aligned
rendering mode that schedules updates on the browser's paint cycle:

```typescript
/**
 * Align stream updates with the browser's animation frame.
 *
 * When enabled, notifications are scheduled via requestAnimationFrame
 * instead of setTimeout, ensuring updates coincide with the browser's
 * paint cycle for the smoothest possible streaming experience.
 *
 * Falls back to setTimeout(0) in environments without rAF (SSR, workers).
 *
 * @default false
 */
syncWithAnimationFrame?: boolean;
```

This is the pattern ChatGPT uses internally: buffer tokens between frames, then
flush once per frame. It produces visually smoother output than any fixed-ms
throttle because it naturally adapts to the display's refresh rate (60Hz, 120Hz,
etc.).

**Implementation in `StreamManager`:**

```typescript
if (this.syncWithAnimationFrame) {
  let rafId: number | undefined;
  const rafListener = () => {
    rafId = undefined;
    listener();
  };
  const scheduledListener = () => {
    if (this.pauseWhenHidden && !visibilityManager.isVisible()) {
      pendingUpdate = true;
      return;
    }
    if (rafId === undefined) {
      rafId = requestAnimationFrame(rafListener);
    }
  };
  // ...
}
```

Note that `requestAnimationFrame` is automatically paused in hidden tabs, which
makes it a natural complement to `pauseRenderingWhenHidden`. When the tab
returns, the first rAF fires, delivering the latest state.

#### B.3 Streaming Markdown Guidance and Utilities

Based on Chrome's best practices guide, provide SDK-level guidance and optional
utilities:

1. **Document the `append()` pattern**: include in framework READMEs that
   streaming Markdown should use `append()` / `insertAdjacentText()`, not
   `textContent +=` or `innerHTML =`.

2. **Recommend streaming Markdown parsers**: document `streaming-markdown` and
   `marked` with streaming configuration as recommended approaches.

3. **Consider a `useStreamingText` hook** (React) / composable (Vue) / store
   (Svelte) that:
   - Takes a message content string that's being streamed
   - Buffers chunks in a ref (no re-render per token)
   - Flushes to state at configurable intervals or via rAF
   - Provides `isStreaming` and `displayText` outputs
   - Handles the "jump to final text" on visibility return

---

### Area C: Developer Experience Improvements

#### C.1 Optimistic Update Helpers

Every example app repeats the same optimistic message append pattern:

```typescript
// This exact pattern appears in Vue, Svelte, Angular, and React examples
submit(
  { messages: [newMessage] },
  {
    optimisticValues: (prev) => ({
      ...prev,
      messages: [...((prev.messages ?? []) as Message[]), newMessage],
    }),
  }
);
```

Provide a built-in helper:

```typescript
// New export from @langchain/langgraph-sdk/ui

/**
 * Creates an optimistic update that appends a human message to the
 * messages array in state.
 */
export function optimisticAppendMessage(
  content: string,
  options?: { type?: string; additionalFields?: Record<string, unknown> }
): SubmitOptions["optimisticValues"] {
  const msg = {
    content,
    type: options?.type ?? "human",
    ...options?.additionalFields,
  };
  return (prev) => ({
    ...prev,
    messages: [...((prev.messages ?? []) as unknown[]), msg],
  });
}
```

Usage becomes:

```typescript
import { optimisticAppendMessage } from "@langchain/langgraph-sdk/ui";

stream.submit(
  { messages: [{ content: input, type: "human" }] },
  { optimisticValues: optimisticAppendMessage(input) }
);
```

#### C.2 Message View Model Helpers

The `ai-elements` example implements a complex `buildRenderItems` function that
maps LangGraph messages to UI rows (grouping tool calls with their results,
separating reasoning blocks, determining streaming state). The `assistant-ui`
example has its own `message-utils.ts` doing similar work.

Provide a shared utility:

```typescript
// libs/sdk/src/ui/message-view-model.ts

export interface MessageViewModel {
  id: string;
  role: "human" | "ai" | "system" | "tool";
  textContent: string;
  toolCalls?: ToolCallViewModel[];
  toolResult?: { callId: string; content: string };
  reasoningBlocks?: string[];
  isStreaming: boolean;
  metadata?: MessageMetadata;
}

export interface ToolCallViewModel {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: string;
  status: "pending" | "running" | "completed" | "error";
}

/**
 * Transform raw LangGraph messages into a flat list of view models
 * suitable for rendering in a chat UI.
 *
 * Groups AI messages with their tool calls and results,
 * separates reasoning blocks, and infers streaming state.
 */
export function buildMessageViewModels(
  messages: Message[],
  options?: {
    isLoading?: boolean;
    toolProgress?: Map<string, ToolProgress>;
  }
): MessageViewModel[];
```

This eliminates the need for every app to build its own message→UI row mapping.

#### C.3 Loading Phase Granularity

Currently `isLoading` is a boolean. Agent UIs benefit from knowing the phase:

```typescript
export type StreamPhase =
  | "idle"         // No active run
  | "submitting"   // Request sent, waiting for first event
  | "thinking"     // Receiving non-content events (tool calls, reasoning)
  | "generating"   // Receiving content tokens
  | "completing";  // Stream ended, running onFinish/history fetch

// Exposed on the stream object
get phase(): StreamPhase;
```

This enables UIs to show different indicators:
- **Submitting**: spinner or "Sending..."
- **Thinking**: pulsing dots or "Analyzing..."
- **Generating**: streaming text animation
- **Completing**: brief "Finalizing..." before idle

**Implementation:** Track phase transitions inside `StreamManager.enqueue()`
based on event types:
- First `values` or `messages` event with content → `"generating"`
- Tool-related events without content → `"thinking"`
- Generator completes → `"completing"` → `"idle"` after `onSuccess`

#### C.4 Auto-Retry with Backoff

Add configurable auto-retry for transient stream failures:

```typescript
/**
 * Automatically retry the stream on transient errors.
 *
 * When the stream disconnects due to a network error, the orchestrator
 * will automatically attempt to rejoin using the stored run ID.
 *
 * @default false
 */
autoRetry?: boolean | {
  /** Maximum number of retry attempts. @default 3 */
  maxAttempts?: number;
  /** Base delay in ms, doubled on each retry. @default 1000 */
  baseDelayMs?: number;
  /** Maximum delay in ms. @default 30000 */
  maxDelayMs?: number;
  /** Called on each retry attempt. Return false to stop retrying. */
  onRetry?: (attempt: number, error: unknown) => boolean | void;
};
```

**Implementation:** In `StreamManager.enqueue()`, when the async generator
throws a network error:
1. If `autoRetry` is enabled and `callbackMeta.run_id` is available, use
   `joinStream(runId)` to rejoin.
2. Apply exponential backoff with jitter.
3. Track retry count and expose `stream.retryCount` for UI feedback.

This closes a significant gap: today, if the SSE connection drops mid-stream,
the user sees an error and must manually refresh. With auto-retry, the stream
automatically recovers using the same `joinStream` + `lastEventId` mechanism
that `reconnectOnMount` uses.

#### C.5 Connection Status

Expose connection health information for building connection status indicators:

```typescript
export type ConnectionStatus =
  | "connected"    // Active stream or ready to stream
  | "connecting"   // Initial connection or reconnecting
  | "reconnecting" // Auto-retry in progress
  | "disconnected" // Stream ended or errored, not retrying
  | "offline";     // Network is offline (from OnlineManager)

// On the stream object
get connectionStatus(): ConnectionStatus;

// Callback for status changes
onConnectionStatusChange?: (status: ConnectionStatus) => void;
```

The `session-persistence` React example already builds a custom
`ConnectionStatus` component — this would standardize that pattern across all
frameworks.

#### C.6 Auto-Scroll Utilities

Every chat UI needs scroll-to-bottom behavior. Instead of leaving this entirely
to the app, provide framework-specific utilities:

**React:**
```typescript
// @langchain/react
export function useStickToBottom(options?: {
  /** Pixel threshold from bottom to consider "stuck" */
  threshold?: number;
  /** Smooth vs instant scroll */
  behavior?: ScrollBehavior;
}): {
  containerRef: React.RefObject<HTMLElement>;
  isAtBottom: boolean;
  scrollToBottom: () => void;
};
```

**All frameworks (SDK-level CSS guidance):**
```css
/* Recommend in docs: container style for auto-scroll */
.chat-messages {
  overflow-y: auto;
  overscroll-behavior-y: contain;
}

/* Recommend content-visibility for off-screen messages */
.chat-message:not(:last-child) {
  content-visibility: auto;
  contain-intrinsic-size: auto 80px;
}
```

The CSS `content-visibility: auto` recommendation alone can provide up to 7x
rendering performance improvement for long chat histories by telling the browser
to skip layout/paint for off-screen messages.

#### C.7 Custom Transport Parity

`useStreamCustom` / `CustomStreamOrchestrator` currently lacks several features
available in the LGP path:

| Feature | LGP | Custom | Proposed |
|---------|-----|--------|----------|
| `toolProgress` | Yes | No | Add via tools stream events |
| Thread history | Yes | No | Add opt-in `fetchHistory` callback |
| Queue / multi-submit | Yes (server-side) | Stub (no-op) | Add client-side queue |
| Reconnect on mount | Yes | No | Add with transport-specific storage |
| `connectionStatus` | Proposed | N/A | Add |
| `phase` | Proposed | N/A | Add |

For custom transports, tool progress can be derived from the same `"tools"`
stream events if the transport emits them. The missing features are
straightforward to add since the patterns exist in `StreamOrchestrator`.

#### C.8 Error Boundary Improvements

The current error handling has a sharp edge: unknown tool events throw in the
React adapter:

```typescript
// libs/sdk-react/src/stream.lgp.tsx:401-405
default: {
  throw new Error(
    `Unexpected tool event: ${(data as { event: string }).event}`,
  );
}
```

This crashes the React render tree. Proposed improvements:
1. **Replace throw with warning + `onError`** for unknown tool events.
2. **Expose `stream.lastError`** separately from `stream.error` so the UI can
   show the latest error without clearing the stream state.
3. **Add `ErrorBoundary`-compatible error recovery**: `stream.clearError()` to
   dismiss errors and continue.

---

## 4. Implementation Plan

### Phase 1: Core Browser State Infrastructure

**Components:** `libs/sdk/src/ui/`

1. Create `visibility.ts` with `VisibilityManager` class and singleton.
2. Create `online.ts` with `OnlineManager` class and singleton.
3. Add `pauseRenderingWhenHidden` to `StreamManagerOptions`.
4. Modify `StreamManager.subscribe()` with visibility-aware notification
   suppression.
5. Add `onReturnToForeground` callback support.
6. Wire `OnlineManager` into `StreamOrchestrator` for `connectionStatus`.
7. Update `StreamOrchestrator` and `CustomStreamOrchestrator` pass-through.
8. Export new types and singletons.
9. Unit tests for `VisibilityManager`, `OnlineManager`, visibility-aware
   subscribe.

### Phase 2: Rendering Performance

**Components:** `libs/sdk/src/ui/manager.ts`

1. Implement leading-edge throttle with trailing flush.
2. Add `syncWithAnimationFrame` option.
3. Add `StreamPhase` tracking in `enqueue()`.
4. Backward-compatible: keep `number | boolean` throttle shorthand working.
5. Unit tests for all throttle modes.

### Phase 3: DX Helpers

**Components:** `libs/sdk/src/ui/`, all framework packages

1. `optimisticAppendMessage` utility.
2. `buildMessageViewModels` utility.
3. `ConnectionStatus` type and tracking.
4. Auto-retry with backoff in `StreamOrchestrator`.
5. Error handling improvements (no throw on unknown tool events).
6. Export helpers from all framework packages.

### Phase 4: Framework-Specific Enhancements

**Components:** `libs/sdk-react/`, `libs/sdk-vue/`, `libs/sdk-svelte/`,
`libs/sdk-angular/`

1. Pass through all new options.
2. Framework-specific auto-scroll utilities.
3. Custom transport parity improvements.
4. Update READMEs and example apps.

### Phase 5: Documentation

1. Concept page: "Optimizing Agent UX Performance".
2. Streaming Markdown rendering guide with Chrome's best practices.
3. `content-visibility` CSS guidance for chat UIs.
4. Updated examples showing `onReturnToForeground`, `phase`, `connectionStatus`.

---

## 5. API Surface Summary

### New Options on `useStream` / `injectStream`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `pauseRenderingWhenHidden` | `boolean` | `true` | Suppress UI notifications when tab is hidden |
| `onReturnToForeground` | `(ctx) => void` | — | Callback when tab returns to foreground with pending updates |
| `syncWithAnimationFrame` | `boolean` | `false` | Align updates with rAF for smoothest rendering |
| `autoRetry` | `boolean \| object` | `false` | Auto-retry on transient stream failures |
| `onConnectionStatusChange` | `(status) => void` | — | Connection state change callback |

### New Properties on Stream Object

| Property | Type | Description |
|----------|------|-------------|
| `phase` | `StreamPhase` | Current stream phase (idle/submitting/thinking/generating/completing) |
| `connectionStatus` | `ConnectionStatus` | Current connection health |
| `isOnline` | `boolean` | Network connectivity state |
| `retryCount` | `number` | Current auto-retry attempt (0 when not retrying) |

### New Exports from `@langchain/langgraph-sdk/ui`

| Export | Type | Description |
|--------|------|-------------|
| `visibilityManager` | `VisibilityManager` | Singleton for page visibility |
| `VisibilityManager` | class | For custom instances / testing |
| `onlineManager` | `OnlineManager` | Singleton for network state |
| `OnlineManager` | class | For custom instances / testing |
| `optimisticAppendMessage` | function | Helper for common optimistic update pattern |
| `buildMessageViewModels` | function | Transform messages to UI view models |

### Modified Behavior

| Scenario | Before | After |
|----------|--------|-------|
| Tab hidden, stream active | Full event processing + notifications | Full event processing, **no** notifications |
| Tab returns after hidden | Normal rendering continues | Single flush with latest state + `onReturnToForeground` |
| `throttle: 50` | Trailing debounce (50ms silence before update) | Leading-edge fire + 50ms throttle window |
| Network drops mid-stream | Error shown, manual recovery | Auto-rejoin with backoff (if `autoRetry` enabled) |
| Unknown tool event | Throws, crashes React tree | Warning + `onError`, rendering continues |

---

## 6. Risks and Mitigations

### Risk: Users depend on side effects in subscriber callbacks

**Mitigation:** Default `pauseRenderingWhenHidden` to `true` but document clearly.
Callbacks (`onCustomEvent`, `onFinish`, `onToolEvent`, etc.) fire inside
`StreamManager.enqueue()`, not in subscriber notifications, so they are
unaffected.

### Risk: SSR / React Native environments have no `document`

**Mitigation:** Both managers gracefully fall back to "always visible" / "always
online" when browser APIs are unavailable. `setEventListener` allows custom
detection.

### Risk: Large state delta on return to foreground

**Mitigation:** `StreamManager` always maintains the latest state. The flush is a
single snapshot read — no backlog of intermediate states to replay.

### Risk: Breaking change for throttle behavior

**Mitigation:** The leading-edge throttle change affects timing characteristics.
To be safe, introduce it behind a version flag or make it opt-in initially.
The `number | boolean` API remains unchanged; only the internal timing shifts.

### Risk: Auto-retry could mask persistent errors

**Mitigation:** `autoRetry` defaults to `false`. When enabled, retries are capped
at `maxAttempts` with exponential backoff. The `onRetry` callback lets apps
decide whether to continue retrying. After max attempts, the error surfaces
normally.

### Risk: `rAF` rendering mode behaves differently in tests

**Mitigation:** `syncWithAnimationFrame` defaults to `false`. Test environments
can use `throttle: false` for synchronous updates. Provide a
`flushAnimationFrame` test utility.

---

## 7. Impact Analysis

### Performance Wins

| Optimization | Impact | Effort |
|-------------|--------|--------|
| `pauseRenderingWhenHidden` | Eliminates all framework reactivity while hidden | Low (shared layer) |
| Leading-edge throttle | Progressive rendering instead of delayed batch | Low (modify existing) |
| rAF-aligned rendering | 60/120 FPS-synced updates, no wasted frames | Medium |
| `content-visibility` CSS guidance | Up to 7x improvement for long chats | Documentation only |
| Message view model (avoid custom reducers) | Reduced JS work per render | Medium |

### DX Wins

| Improvement | Impact | Effort |
|-------------|--------|--------|
| `optimisticAppendMessage` | Eliminates most common boilerplate | Low |
| `buildMessageViewModels` | Eliminates custom message reducers | Medium |
| `StreamPhase` | Richer loading indicators without custom logic | Medium |
| `ConnectionStatus` | Standardized connection UI across frameworks | Medium |
| Auto-retry | Resilient streaming without app-level retry logic | Medium |
| Error handling fix | Prevents render tree crashes | Low |

### Compatibility

| Framework | Compatibility Notes |
|-----------|-------------------|
| **React** | `useSyncExternalStore` fully compatible; rAF mode natural fit |
| **Vue** | Version ref suppression works; `computed` recalculates once on flush |
| **Svelte** | Derived stores recalculate once on flush; `fromStore` transparent |
| **Angular** | Signal suppression works; single `effect` run on flush |

### What This Does NOT Change

- **Stream connection**: SSE/HTTP stays open; server generation is uninterrupted.
- **Internal state**: Always current regardless of visibility.
- **Callbacks**: `onCreated`, `onFinish`, `onError` fire normally.
- **Reconnect**: Existing `reconnectOnMount` / `sessionStorage` unchanged.

---

## 8. Comprehensive Prior Art Comparison

| Concern | TanStack Query | SWR | Apollo | Vercel AI SDK | Socket.IO | LangGraph (current) | LangGraph (proposed) |
|---------|---------------|-----|--------|---------------|-----------|--------------------|--------------------|
| **Visibility** | `FocusManager` | `revalidateOnFocus` | `skipPollAttempt` | None | N/A | None | `VisibilityManager` |
| **Network** | `OnlineManager` | `refreshWhenOffline` | N/A | Resume streams | Auto-reconnect | `reconnectOnMount` | `OnlineManager` + auto-retry |
| **Throttle** | N/A | N/A | N/A | `experimental_throttle` | N/A | Trailing debounce | Leading throttle + rAF |
| **Phase/Status** | `status` enum | `isValidating` | `loading`/`error`/`data` | N/A | `connected`/etc. | `isLoading` boolean | `StreamPhase` + `ConnectionStatus` |
| **Message helpers** | N/A | N/A | N/A | `useChat` messages | N/A | Raw messages | View model helpers |
| **Error recovery** | Auto-retry | `onErrorRetry` | Link error policies | Resume | Reconnect | Manual | Auto-retry with backoff |

---

## 9. Future Considerations

### 9.1 `IntersectionObserver`-Based Rendering

For chat UIs with long message lists, provide utilities that skip expensive
rendering (syntax highlighting, Markdown parsing) for messages scrolled out of
the viewport. Combined with `content-visibility: auto`, this creates a
virtualization-like experience without the complexity of windowing libraries.

### 9.2 React 19.2 `<Activity>` Integration

Provide a `<StreamActivity>` wrapper that automatically sets
`mode="hidden"` when the browser tab is hidden, combining browser-level
visibility with React's built-in deferred rendering.

### 9.3 Adaptive Throttle

Dynamically adjust throttle rate based on:
- Stream velocity (tokens/second) — faster streams need more aggressive throttle
- Device capabilities (`navigator.deviceMemory`, `navigator.hardwareConcurrency`)
- Battery status (`navigator.getBattery()`)
- Current frame rate (if rAF mode, detect jank and increase throttle)

### 9.4 Web Worker Stream Processing

Move `StreamManager.enqueue()` event processing to a Web Worker to avoid main
thread contention entirely. Web Workers are not subject to background tab
throttling, so event processing would continue at full speed. Only serialized
state snapshots would be posted to the main thread on visibility return.

### 9.5 Streaming Text Animation Utilities

Provide a `useStreamingAnimation` primitive that decouples network chunk
delivery from visual character rendering:
- Buffers incoming chunks
- Renders characters at a consistent rate (e.g., 15ms per character)
- Catches up instantly when the user scrolls or returns from a hidden tab
- Smooth acceleration/deceleration at stream start/end

This is the technique ChatGPT and other polished chat UIs use to create the
"typing" effect that feels natural regardless of network jitter.

### 9.6 Headless Chat UI Components

Consider providing framework-specific headless chat components (similar to
Headless UI or Radix) that handle:
- Message list with auto-scroll
- Composer input with Enter/Shift+Enter handling
- Stop button with loading state
- Error banner with retry
- Connection status indicator
- Thread switcher

These would be unstyled, composable, and encapsulate the patterns that every
example app currently reimplements.

### 9.7 Message Content Utilities

Provide helpers for common message content operations:
- `getTextContent(message)`: Extract text from string or array content
- `getImageContent(message)`: Extract image URLs/data from multimodal messages
- `hasContent(message)`: Check if message has any displayable content
- `copyMessageText(message)`: Format message text for clipboard
- `getReasoningBlocks(message)`: Extract reasoning/thinking blocks

These are utility functions that multiple example apps implement independently.

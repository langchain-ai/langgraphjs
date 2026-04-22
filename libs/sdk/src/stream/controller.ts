/**
 * Framework-agnostic controller for the experimental v2 stream.
 *
 * Responsibilities:
 *  - Owns at most one {@link ThreadStream} at a time (swapped on
 *    `hydrate(newThreadId)` or `dispose`).
 *  - Exposes three always-on observable surfaces via {@link StreamStore}:
 *      - `rootStore`      : root values/messages/toolCalls/interrupts/…
 *      - `subagentStore`  : discovery map of subagents (no content)
 *      - `subgraphStore`  : discovery map of subgraphs  (no content)
 *  - Owns a {@link ChannelRegistry} that framework selector hooks
 *    (`useMessages`, `useToolCalls`, `useExtension`, `useChannel`)
 *    use to lazily open per-namespace subscriptions.
 *  - Imperative run surface: `submit`, `stop`, `respond`, `joinStream`.
 *
 * A single multi-channel subscription (`values`, `lifecycle`, `input`,
 * `messages`, `tools`) powers every always-on projection and both
 * discovery runners. Selector hooks add their own (deduped)
 * subscriptions on top — so even a UI with many subagents only opens
 * one extra subscription per `(channels, namespace)` actually
 * rendered on screen.
 */
import { v7 as uuidv7 } from "uuid";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type {
  Channel,
  Event,
  LifecycleEvent,
  MessagesEvent,
  MessageRole,
  MessageStartData,
  ToolsEvent,
  ValuesEvent,
} from "@langchain/protocol";
import type { Interrupt } from "../schema.js";
import type { ThreadStream } from "../client/stream/index.js";
import type { SubscriptionHandle } from "../client/stream/index.js";
import { MessageAssembler } from "../client/stream/messages.js";
import {
  ToolCallAssembler,
  type AssembledToolCall,
} from "../client/stream/handles/tools.js";
import { ensureMessageInstances } from "../ui/messages.js";
import type { Message } from "../types.messages.js";
import { StreamStore } from "./store.js";
import { ChannelRegistry } from "./channel-registry.js";
import {
  SubagentDiscovery,
  type SubagentMap,
  SubgraphDiscovery,
  type SubgraphMap,
  type SubgraphByNodeMap,
} from "./discovery/index.js";
import {
  assembledMessageToBaseMessage,
  type ExtendedMessageRole,
} from "./assembled-to-message.js";
import type {
  RootEventBus,
  RootSnapshot,
  StreamControllerOptions,
  StreamSubmitOptions,
} from "./types.js";

const ROOT_NAMESPACE: readonly string[] = [];

/**
 * Gated diagnostic logger for the root event pump. Silent by default so
 * high-frequency streaming runs don't pay for `console.log` formatting
 * on every delta. Opt in from the browser DevTools console by setting
 * `globalThis.__LG_STREAM_DEBUG__ = true` before submitting a run; the
 * logs then show the event ordering / pump transitions needed to
 * diagnose stuck-UI regressions like the fan-out render loop that
 * motivated the resilience try/catch in `#startRootPump`.
 */
function lgDebug(tag: string, ...args: unknown[]): void {
  if (
    (globalThis as { __LG_STREAM_DEBUG__?: boolean }).__LG_STREAM_DEBUG__ !==
    true
  ) {
    return;
  }
  console.log(`[lg:${tag}]`, ...args);
}

/**
 * Channel set covered by the always-on root subscription. Exported so
 * projections (and transports) can reason about what the root pump
 * already delivers before opening additional server subscriptions.
 */
export const ROOT_PUMP_CHANNELS: readonly Channel[] = [
  "values",
  "lifecycle",
  "input",
  "messages",
  "tools",
];

interface ResolvedInterrupt {
  interruptId: string;
  namespace: string[];
}

export class StreamController<
  StateType extends object = Record<string, unknown>,
  InterruptType = unknown,
  ConfigurableType extends object = Record<string, unknown>,
> {
  readonly rootStore: StreamStore<RootSnapshot<StateType, InterruptType>>;
  readonly subagentStore: StreamStore<SubagentMap>;
  readonly subgraphStore: StreamStore<SubgraphMap>;
  readonly subgraphByNodeStore: StreamStore<SubgraphByNodeMap>;
  readonly registry: ChannelRegistry;

  readonly #options: StreamControllerOptions<StateType>;
  readonly #messagesKey: string;
  readonly #subagents = new SubagentDiscovery();
  readonly #subgraphs = new SubgraphDiscovery();

  #thread: ThreadStream | undefined;
  #currentThreadId: string | null;
  #rootSubscription: SubscriptionHandle<Event> | undefined;
  #rootPump: Promise<void> | undefined;
  #threadEventUnsubscribe: (() => void) | undefined;
  #runAbort: AbortController | undefined;
  #disposed = false;
  #pendingDisposeTimer: ReturnType<typeof setTimeout> | null = null;
  readonly #resolvedInterrupts = new Set<string>();
  /**
   * Thread ids we minted client-side on first `submit()`. Keeping them
   * here lets `hydrate()` skip the `threads.getState()` round-trip —
   * we know there is nothing checkpointed server-side yet (and the
   * request would 404 and surface a spurious error to the UI).
   */
  readonly #selfCreatedThreadIds = new Set<string>();
  readonly #rootEventListeners = new Set<(event: Event) => void>();
  readonly #rootBus: RootEventBus;

  // Assemblers that live for the lifetime of a thread; reset on
  // rebind so a fresh thread starts with a clean slate.
  #rootMessageAssembler = new MessageAssembler();
  readonly #rootMessageRoles = new Map<
    string,
    { role: ExtendedMessageRole; toolCallId?: string }
  >();
  readonly #rootMessageIndex = new Map<string, number>();
  #rootToolAssembler = new ToolCallAssembler();
  // Maps the namespace a tool result is streamed on (`["tools:<uuid>"]`)
  // to the `tool_call_id` reported by that namespace's most recent
  // `tool-started` event. The `messages` channel's `message-start`
  // for a `role: "tool"` response does NOT carry the tool_call_id
  // itself — the correlation lives on the `tools` channel — so we
  // stash it here and look it up when the tool message begins.
  readonly #toolCallIdByNamespace = new Map<string, string>();

  readonly #threadListeners = new Set<
    (thread: ThreadStream | undefined) => void
  >();

  constructor(options: StreamControllerOptions<StateType>) {
    this.#options = options;
    this.#messagesKey = options.messagesKey ?? "messages";
    this.#currentThreadId = options.threadId ?? null;
    this.#rootBus = {
      channels: ROOT_PUMP_CHANNELS,
      subscribe: (listener) => {
        this.#rootEventListeners.add(listener);
        return () => {
          this.#rootEventListeners.delete(listener);
        };
      },
    };
    this.registry = new ChannelRegistry(this.#rootBus);
    this.subagentStore = this.#subagents.store;
    this.subgraphStore = this.#subgraphs.store;
    this.subgraphByNodeStore = this.#subgraphs.byNodeStore;
    this.rootStore = new StreamStore<RootSnapshot<StateType, InterruptType>>(
      this.#createInitialSnapshot()
    );
  }

  // ---------- public imperatives ----------

  /**
   * Fetch the checkpointed thread state and seed the root snapshot.
   * Re-calling with a different `threadId` swaps the underlying
   * {@link ThreadStream}, rewires the registry to the new thread, and
   * resets assemblers.
   */
  async hydrate(threadId?: string | null): Promise<void> {
    if (this.#disposed) return;
    const target = threadId === undefined ? this.#currentThreadId : threadId;
    const changed = target !== this.#currentThreadId;
    this.#currentThreadId = target ?? null;
    this.rootStore.setState((s) => ({ ...s, threadId: this.#currentThreadId }));

    if (changed) {
      await this.#teardownThread();
      // Reset UI-facing snapshot so stale messages/values/tool-calls
      // from the previous thread don't bleed into the new one. The
      // new thread's state (if any) is then populated below via
      // `#applyValues`.
      this.rootStore.setState(() => ({
        ...this.#createInitialSnapshot(),
        threadId: this.#currentThreadId,
      }));
    }

    if (this.#currentThreadId == null) {
      this.rootStore.setState((s) => ({ ...s, isThreadLoading: false }));
      return;
    }

    // Self-generated thread ids have nothing to fetch server-side yet
    // — the thread is created lazily by the first `run.input`. Calling
    // `threads.getState()` here would return a 404 and surface a
    // spurious error to the UI.
    if (this.#selfCreatedThreadIds.has(this.#currentThreadId)) {
      this.rootStore.setState((s) => ({ ...s, isThreadLoading: false }));
      return;
    }

    this.rootStore.setState((s) => ({ ...s, isThreadLoading: true }));
    try {
      const state = await this.#options.client.threads.getState<StateType>(
        this.#currentThreadId
      );
      if (state?.checkpoint != null && state.values != null) {
        this.#applyValues(state.values as unknown);
      }
    } catch (error) {
      this.rootStore.setState((s) => ({ ...s, error }));
    } finally {
      this.rootStore.setState((s) => ({ ...s, isThreadLoading: false }));
    }
  }

  async submit(
    input: unknown,
    options?: StreamSubmitOptions<StateType, ConfigurableType>
  ): Promise<void> {
    if (this.#disposed) return;
    if (this.#currentThreadId == null) {
      this.#currentThreadId = uuidv7();
      this.#selfCreatedThreadIds.add(this.#currentThreadId);
      this.#options.onThreadId?.(this.#currentThreadId);
      this.rootStore.setState((s) => ({
        ...s,
        threadId: this.#currentThreadId,
      }));
    }
    const thread = this.#ensureThread(this.#currentThreadId);

    this.#runAbort?.abort();
    const abort = new AbortController();
    this.#runAbort = abort;

    const resumeCommand = options?.command?.resume;
    const isResume = resumeCommand !== undefined;

    this.rootStore.setState((s) => ({
      ...s,
      interrupts: [],
      interrupt: undefined,
      error: undefined,
      isLoading: true,
    }));

    const boundConfig = bindThreadConfig(
      options?.config,
      this.#currentThreadId
    );

    // Register the terminal-lifecycle listener on the root bus BEFORE
    // dispatching the command that triggers the run. The root pump
    // fans events out synchronously on arrival, so a late
    // registration could miss the terminal for short-lived runs
    // (particularly `input.respond` which the server can complete in
    // a single round-trip).
    const terminalPromise = this.#awaitNextTerminal(abort.signal);

    try {
      if (isResume) {
        const target = this.#latestUnresolvedInterrupt();
        if (target == null) {
          throw new Error(
            "submit({ command: { resume } }) called but no pending protocol interrupt is available."
          );
        }
        await thread.respondInput({
          namespace: target.namespace,
          interrupt_id: target.interruptId,
          response: resumeCommand,
        });
        this.#resolvedInterrupts.add(target.interruptId);
      } else {
        const result = await thread.submitRun({
          input: input ?? null,
          config: boundConfig,
          metadata: (options?.metadata ?? undefined) as Record<string, unknown>,
        });
        this.#options.onCreated?.({
          run_id: result.run_id as string,
          thread_id: this.#currentThreadId,
        });
      }

      await terminalPromise;
    } catch (error) {
      if (!abort.signal.aborted) {
        this.rootStore.setState((s) => ({ ...s, error }));
      }
    } finally {
      this.rootStore.setState((s) => ({ ...s, isLoading: false }));
      if (this.#runAbort === abort) this.#runAbort = undefined;
    }
  }

  async stop(): Promise<void> {
    this.#runAbort?.abort();
    this.#runAbort = undefined;
    this.rootStore.setState((s) => ({ ...s, isLoading: false }));
  }

  async respond(
    response: unknown,
    target?: { interruptId: string; namespace?: string[] }
  ): Promise<void> {
    if (this.#disposed || this.#thread == null) {
      throw new Error("No active thread to respond to.");
    }
    const resolved =
      target != null
        ? {
            interruptId: target.interruptId,
            namespace: target.namespace ?? [...ROOT_NAMESPACE],
          }
        : this.#latestUnresolvedInterrupt();
    if (resolved == null) {
      throw new Error("No pending interrupt to respond to.");
    }
    await this.#thread.respondInput({
      namespace: resolved.namespace,
      interrupt_id: resolved.interruptId,
      response,
    });
    this.#resolvedInterrupts.add(resolved.interruptId);
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#cancelPendingDispose();
    this.#disposed = true;
    this.#runAbort?.abort();
    this.#runAbort = undefined;
    await this.#teardownThread();
    await this.registry.dispose();
    this.#threadListeners.clear();
  }

  /**
   * StrictMode-safe lifecycle hook for framework bindings.
   *
   * React 18+ `StrictMode` intentionally mounts → unmounts → remounts
   * components in dev to surface effect-cleanup bugs. A naive
   * `useEffect(() => () => controller.dispose())` would permanently
   * tear the controller down on that first synthetic unmount, leaving
   * every subsequent `submit()` a silent no-op.
   *
   * Call {@link activate} from the bind site's effect and return the
   * result as the effect's cleanup. The controller uses deferred
   * disposal: a `release()` only schedules a dispose on the next
   * microtask, which is cancelled if another `activate()` arrives
   * before it fires (the normal StrictMode remount path).
   */
  activate(): () => void {
    this.#cancelPendingDispose();
    return () => {
      if (this.#disposed) return;
      this.#pendingDisposeTimer = setTimeout(() => {
        this.#pendingDisposeTimer = null;
        void this.dispose().catch(() => undefined);
      }, 0);
    };
  }

  #cancelPendingDispose(): void {
    if (this.#pendingDisposeTimer != null) {
      clearTimeout(this.#pendingDisposeTimer);
      this.#pendingDisposeTimer = null;
    }
  }

  // ---------- escape hatches ----------

  /** Current underlying {@link ThreadStream} (v2 escape hatch). */
  getThread(): ThreadStream | undefined {
    return this.#thread;
  }

  /**
   * Listen for `ThreadStream` lifecycle (swap on thread-id change,
   * detach on dispose). The listener fires immediately with the
   * current thread (may be `undefined`).
   */
  subscribeThread(
    listener: (thread: ThreadStream | undefined) => void
  ): () => void {
    this.#threadListeners.add(listener);
    listener(this.#thread);
    return () => {
      this.#threadListeners.delete(listener);
    };
  }

  // ---------- internals ----------

  #createInitialSnapshot(): RootSnapshot<StateType, InterruptType> {
    const values = (this.#options.initialValues ??
      ({} as StateType)) as StateType;
    const messages = extractAndCoerceMessages(values, this.#messagesKey);
    return {
      values,
      messages,
      toolCalls: [],
      interrupts: [],
      interrupt: undefined,
      isLoading: false,
      isThreadLoading: false,
      error: undefined,
      threadId: this.#currentThreadId,
    };
  }

  #ensureThread(threadId: string): ThreadStream {
    if (this.#thread != null) return this.#thread;
    this.#thread = this.#options.client.threads.stream(threadId, {
      assistantId: this.#options.assistantId,
      transport: this.#options.transport,
      fetch: this.#options.fetch,
      webSocketFactory: this.#options.webSocketFactory,
    });
    this.registry.bind(this.#thread);
    this.#startRootPump(this.#thread);
    this.#notifyThreadListeners();
    return this.#thread;
  }

  async #teardownThread(): Promise<void> {
    const thread = this.#thread;
    this.#thread = undefined;
    this.registry.bind(undefined);
    this.#threadEventUnsubscribe?.();
    this.#threadEventUnsubscribe = undefined;
    try {
      await this.#rootSubscription?.unsubscribe();
    } catch {
      /* already closed */
    }
    this.#rootSubscription = undefined;
    try {
      await this.#rootPump;
    } catch {
      /* ignore */
    }
    this.#rootPump = undefined;

    // Reset per-thread assembly state.
    this.#rootMessageAssembler = new MessageAssembler();
    this.#rootMessageRoles.clear();
    this.#rootMessageIndex.clear();
    this.#rootToolAssembler = new ToolCallAssembler();
    this.#toolCallIdByNamespace.clear();

    if (thread != null) {
      try {
        await thread.close();
      } catch {
        /* already closed */
      }
      this.#notifyThreadListeners();
    }
  }

  #startRootPump(thread: ThreadStream): void {
    if (this.#rootPump != null) return;

    // Wildcard discovery + interrupt tracking is delivered via the
    // thread's dedicated lifecycle watcher (see `ThreadStream.onEvent`).
    // This callback fires once per globally-unique event across both
    // the content pump AND the watcher, so we can drive discovery
    // runners and nested HITL capture without widening the content
    // pump's narrow filter.
    this.#threadEventUnsubscribe = thread.onEvent((event) =>
      this.#onWildcardEvent(event)
    );

    this.#rootPump = (async () => {
      try {
        // Narrow the content pump to the root namespace, depth 1:
        // this is enough to observe root LLM deltas and first-level
        // discovery hints (tool-started for task:* / subgraph
        // boundaries) without downloading content from every nested
        // subagent / subgraph. Deeper content is pulled in lazily by
        // per-namespace selector projections (e.g. `useMessages(sub)`),
        // which expand `#computeUnionFilter` progressively.
        const subscription = await thread.subscribe({
          channels: [...ROOT_PUMP_CHANNELS] as Channel[],
          namespaces: [[] as string[]],
          depth: 1,
        });
        lgDebug("root-pump.subscribed", {
          channels: [...ROOT_PUMP_CHANNELS],
          subId: subscription.subscriptionId,
        });
        this.#rootSubscription = subscription;
        // The SSE transport pauses the underlying subscription when
        // a terminal root lifecycle event arrives (so `for await`
        // loops observing a single run exit cleanly) and re-opens
        // the next run's server stream on `#prepareForNextRun`,
        // resuming the subscription handle. The root pump needs to
        // survive that hand-off: we re-enter the inner `for await`
        // for every resumed iteration until the subscription is
        // permanently closed or the controller is disposed.
        let iterationCount = 0;
        while (!this.#disposed) {
          iterationCount += 1;
          let perIterCount = 0;
          lgDebug("root-pump.iter-start", { iterationCount });
          for await (const event of subscription) {
            if (this.#disposed) {
              lgDebug("root-pump.disposed-break", {
                iterationCount,
                perIterCount,
              });
              break;
            }
            perIterCount += 1;
            // Resilience: isolate per-event dispatch from the pump loop.
            //
            // `#onRootEvent` runs synchronously and, transitively,
            // invokes every root-bus listener (selector projections that
            // opted into the shared stream) plus every `rootStore`
            // subscriber. Some of those subscribers live in a React
            // render tree — `useStreamExperimental` drives
            // `useSyncExternalStore`, so a misbehaving component can
            // surface a render-phase error ("Maximum update depth
            // exceeded", "The result of getSnapshot should be cached",
            // etc.) that propagates out here.
            //
            // Without this guard, a single throw bubbles through the
            // `for await` loop and terminates the root pump permanently.
            // That is catastrophic: no more root events get processed —
            // the terminal `lifecycle: completed` never lands, so
            // `#awaitNextTerminal` never resolves, `isLoading` stays
            // `true`, composers stay disabled, and the final assistant
            // turn never commits to `stream.messages`. The UI looks
            // hung even though the server is still emitting events
            // (and `ThreadStream.onEvent` keeps firing).
            //
            // We therefore swallow the error and keep pumping. The
            // underlying component bug is still reported via `lgDebug`
            // (opt in with `globalThis.__LG_STREAM_DEBUG__ = true` in
            // DevTools to surface the full stack for diagnosis) — but
            // the pump's correctness guarantees do not depend on any
            // consumer behaving well.
            try {
              this.#onRootEvent(event);
            } catch (err) {
              const errObj = err as Error;
              const evSeq = (event as unknown as { seq?: number }).seq;
              const evEventKind = (
                event.params.data as { event?: string } | undefined
              )?.event;
              lgDebug("root-event.THREW", {
                seq: evSeq,
                method: event.method,
                ns: event.params.namespace,
                event: evEventKind,
                error: errObj?.message,
                stack: errObj?.stack,
              });
            }
          }
          lgDebug("root-pump.iter-end", {
            iterationCount,
            perIterCount,
            disposed: this.#disposed,
            isPaused: subscription.isPaused,
          });
          if (this.#disposed) break;
          if (!subscription.isPaused) {
            lgDebug("root-pump.exit-not-paused", { iterationCount });
            break;
          }
          await subscription.waitForResume();
          lgDebug("root-pump.resumed", { iterationCount });
        }
        lgDebug("root-pump.loop-exit", { iterationCount });
      } catch (err) {
        lgDebug("root-pump.error", { error: String(err) });
        /* thread closed or errored */
      }
    })();
  }

  /**
   * Handle an event delivered via {@link ThreadStream.onEvent}.
   *
   * `onEvent` fires once per globally-unique event across the content
   * pump and the wildcard lifecycle watcher, so this is the single
   * entry point for wildcard discovery / interrupt tracking. It does
   * NOT fan events out to the root bus (that's driven by the content
   * pump iterator so root-bus short-circuits stay depth-1 scoped) and
   * it does NOT process root content — messages/tools/values at root
   * are handled by `#onRootEvent` off the content pump.
   */
  #onWildcardEvent(event: Event): void {
    this.#subagents.push(event);
    this.#subgraphs.push(event);

    // Nested `input.requested` events (HITL inside a subagent /
    // subgraph) are not observable via the narrow content pump. The
    // `ThreadStream` itself already records them into
    // `thread.interrupts`, which `#latestUnresolvedInterrupt()`
    // consults — so HITL respond() works for any depth. Root-level
    // interrupts stay in `rootStore.interrupts` via `#onRootEvent`.
    void event;
  }

  #onRootEvent(event: Event): void {
    const evSeq = (event as unknown as { seq?: number }).seq;
    const evEventKind = (event.params.data as { event?: string } | undefined)
      ?.event;
    lgDebug("root-event", {
      seq: evSeq,
      method: event.method,
      ns: event.params.namespace,
      event: evEventKind,
    });
    // Discovery runners are fed by the wildcard lifecycle watcher via
    // `thread.onEvent` so deeply-nested subagents/subgraphs are
    // discovered even when the content pump stays narrow. See
    // `#onWildcardEvent`.

    // Fan root-pump events out to every root-bus listener (selector
    // projections that opted into the shared stream,
    // `#awaitTerminal`, etc.). The root bus mirrors the content
    // pump's narrow scope (depth 1 at root) so projections that
    // short-circuit via the bus stay bounded.
    if (this.#rootEventListeners.size > 0) {
      for (const listener of this.#rootEventListeners) {
        try {
          listener(event);
        } catch {
          // Best-effort — a bad listener should not wedge other
          // projections or the root pump itself.
        }
      }
    }

    // `messages` and `tools` events are emitted under a node's
    // namespace — for a typical StateGraph the LLM's token deltas
    // land on `["model:<uuid>"]`, tool executions on
    // `["tools:<uuid>"]`, etc. The orchestrator's own turns (root
    // agent, or an orchestrator-scoped subgraph like `model:*` /
    // `model_request:*`) belong in `root.messages` and
    // `root.toolCalls`.
    //
    // Subagent / tool-internal branches do NOT:
    //   - `task:*` segment — legacy subagent convention.
    //   - `tools:*` segment — every tool execution is wrapped in a
    //     `tools` subgraph. For simple tools its only content is
    //     the eventual tool result (also echoed verbatim by
    //     `values.messages` so we don't lose anything). For the
    //     deep-agent `task` tool its content IS the spawned
    //     subagent's full message + tool stream, which is surfaced
    //     separately via `useMessages(stream, subagent)` /
    //     `useToolCalls(stream, subagent)`.
    //
    // We therefore drop `messages` events from any namespace that
    // contains a `task:*` or `tools:*` segment; the authoritative
    // tool-result text lands in `root.messages` via the root
    // `values.messages` snapshot merge in `#applyValues`.
    const isInternalNamespace = event.params.namespace.some(
      (seg) => seg.startsWith("task:") || seg.startsWith("tools:")
    );
    const isLegacySubagentNamespace = event.params.namespace.some((seg) =>
      seg.startsWith("task:")
    );

    if (event.method === "messages") {
      if (!isInternalNamespace) {
        this.#onRootMessage(event as MessagesEvent);
      }
      return;
    }

    if (event.method === "tools") {
      // Root-level tool events (both for simple orchestrator tools
      // and the deep-agent `task` dispatcher) fire at a
      // single-segment `["tools:<id>"]` namespace. Anything deeper
      // (e.g. `[tools:<outer>, tools:<inner>]`) is a subagent's own
      // tool call and belongs to that subagent's `useToolCalls`
      // view, not the orchestrator's `root.toolCalls`.
      const isRootLevelTool =
        event.params.namespace.length <= 1 && !isLegacySubagentNamespace;
      if (isRootLevelTool) {
        // Record the `namespace → tool_call_id` association so that
        // the ensuing `message-start` (role: "tool") at the same
        // namespace can recover the `tool_call_id` (the `messages`
        // channel's start event doesn't carry it directly).
        const toolData = event.params.data as {
          event?: string;
          tool_call_id?: string;
        };
        if (
          toolData.event === "tool-started" &&
          typeof toolData.tool_call_id === "string"
        ) {
          this.#toolCallIdByNamespace.set(
            namespaceKey(event.params.namespace),
            toolData.tool_call_id
          );
        }
        const tc = this.#rootToolAssembler.consume(event as ToolsEvent);
        if (tc != null) {
          this.rootStore.setState((s) => ({
            ...s,
            toolCalls: appendToolCall(s.toolCalls, tc),
          }));
        }
      }
      return;
    }

    // Channels below are only meaningful at the root namespace.
    const isRoot = event.params.namespace.length === 0;
    if (!isRoot) return;

    if (event.method === "values") {
      const raw = (event as ValuesEvent).params.data;
      this.#applyValues(raw);
      return;
    }

    if (event.method === "input.requested") {
      const data = event.params.data as {
        interrupt_id?: string;
        payload?: unknown;
      };
      const interruptId = data?.interrupt_id;
      if (
        typeof interruptId === "string" &&
        !this.#resolvedInterrupts.has(interruptId)
      ) {
        const interrupt: Interrupt<InterruptType> = {
          id: interruptId,
          value: data.payload as InterruptType,
        };
        this.rootStore.setState((s) => {
          if (s.interrupts.some((entry) => entry.id === interruptId)) return s;
          const interrupts = [...s.interrupts, interrupt];
          return { ...s, interrupts, interrupt: interrupts[0] };
        });
      }
      return;
    }

    if (event.method === "lifecycle") {
      // Root lifecycle transitions are observed elsewhere
      // (#awaitTerminal) to unblock `submit`.
      const lifecycle = (event as LifecycleEvent).params.data as {
        event?: string;
      };
      void lifecycle;
    }
  }

  #onRootMessage(event: MessagesEvent): void {
    const data = event.params.data;
    if (data.event === "message-start") {
      const startData = data as MessageStartData;
      const role = (startData.role ?? "ai") as MessageRole;
      const extendedRole =
        (startData as { role?: ExtendedMessageRole }).role ?? role;
      let toolCallId = (startData as { tool_call_id?: string }).tool_call_id;
      // Tool-role messages don't carry `tool_call_id` on the
      // `message-start` event itself — the correlation lives in
      // the message id, which follows the LangGraph convention
      // `run-<run_id>-tool-<tool_call_id>` (multiple tool calls
      // can execute under the same `tools:<uuid>` namespace, so a
      // namespace-keyed map alone would collide on parallel tool
      // invocations). We also fall back to the `namespace →
      // tool_call_id` map from the `tools` channel's
      // `tool-started` event for tool messages whose id doesn't
      // follow that format.
      //
      // Without this recovery the resulting ToolMessage has
      // `tool_call_id: ""`, so the UI can't pair it with the
      // AI's `tool_calls[].id` and the tool result renders in
      // its own bubble with a perpetually-"pending" status pill.
      if (extendedRole === "tool" && toolCallId == null) {
        const messageId = startData.message_id;
        if (messageId != null) {
          const match = /-tool-(.+)$/.exec(messageId);
          if (match != null) toolCallId = match[1];
        }
        if (toolCallId == null) {
          toolCallId = this.#toolCallIdByNamespace.get(
            namespaceKey(event.params.namespace)
          );
        }
      }
      if (startData.message_id != null) {
        this.#rootMessageRoles.set(startData.message_id, {
          role: extendedRole,
          toolCallId,
        });
      }
    }

    const update = this.#rootMessageAssembler.consume(event);
    const id = update.message.messageId;
    if (id == null) return;
    const captured = this.#rootMessageRoles.get(id) ?? { role: "ai" as const };
    const base = assembledMessageToBaseMessage(update.message, captured.role, {
      toolCallId: captured.toolCallId,
    });

    this.rootStore.setState((s) => {
      const existingIdx = this.#rootMessageIndex.get(id);
      if (existingIdx == null) {
        this.#rootMessageIndex.set(id, s.messages.length);
        return { ...s, messages: [...s.messages, base] };
      }
      const messages = s.messages.slice();
      messages[existingIdx] = base;
      return { ...s, messages };
    });
  }

  #applyValues(raw: unknown): void {
    if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
      return;
    }
    const state = raw as Record<string, unknown>;
    const maybeMessages = state[this.#messagesKey];
    let nextValues: StateType;
    let nextMessages: BaseMessage[];
    if (Array.isArray(maybeMessages)) {
      const coerced = ensureMessageInstances(
        maybeMessages as (Message | BaseMessage)[]
      );
      nextValues = {
        ...(state as StateType),
        [this.#messagesKey]: coerced,
      } as StateType;
      nextMessages = coerced;
    } else {
      nextValues = state as StateType;
      nextMessages = [];
    }
    this.rootStore.setState((s) => {
      if (nextMessages.length === 0) {
        return { ...s, values: nextValues };
      }
      // Merge `values.messages` with the stream-assembled projection.
      //
      // The `messages` channel delivers token-level deltas that we
      // fold into `s.messages` via `#onRootMessage`. Those streamed
      // messages are also echoed back in the `values` snapshot when
      // a superstep finishes — but wholesale replacing with
      // `values.messages` here would stomp on any in-progress
      // streaming message (the user would see the final turn appear
      // in a single render instead of streaming token-by-token).
      //
      // Strategy: for each message in `values.messages`, prefer the
      // stream-assembled version if we have one for the same id.
      // `values.messages` remains authoritative for ORDER and for
      // non-streamed messages (human turns, tool results serialised
      // from state, subagent echoes, …). New ids in values that we
      // haven't seen via the channel are appended verbatim.
      const valueIds = new Set<string>();
      const merged = nextMessages.map((msg) => {
        const id = msg.id;
        if (id != null) valueIds.add(id);
        if (id == null) return msg;
        const streamIdx = this.#rootMessageIndex.get(id);
        if (streamIdx == null) return msg;
        const streamed = s.messages[streamIdx];
        return streamed ?? msg;
      });
      // Preserve any stream-assembled messages that haven't yet been
      // echoed into `values.messages`. This happens when a node emits
      // token deltas before the enclosing superstep's values snapshot
      // lands — e.g. the next assistant turn is already streaming
      // while we receive a values event describing the previous
      // superstep. Without this, the merge would truncate them and
      // the UI would flash between renders.
      for (const existing of s.messages) {
        const id = existing.id;
        if (id == null) continue;
        if (valueIds.has(id)) continue;
        merged.push(existing);
      }
      // Keep `rootMessageIndex` aligned with the new positions so
      // subsequent channel deltas still resolve the right slot.
      this.#rootMessageIndex.clear();
      merged.forEach((msg, idx) => {
        if (msg.id != null) this.#rootMessageIndex.set(msg.id, idx);
      });
      return {
        ...s,
        values: {
          ...(nextValues as Record<string, unknown>),
          [this.#messagesKey]: merged,
        } as StateType,
        messages: merged,
      };
    });
  }

  /**
   * Resolve on the next root-namespace terminal lifecycle event
   * (`completed` / `failed` / `interrupted`) or on abort.
   *
   * Attaches to the controller's root event bus instead of opening
   * a second server subscription. Callers should register the
   * returned promise **before** dispatching the command that
   * triggers the run (`thread.run.input` / `thread.input.respond`)
   * — the root pump fans events out synchronously on arrival, so a
   * late registration would miss the terminal for fast runs.
   */
  #awaitNextTerminal(signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        unsubscribe();
        signal.removeEventListener("abort", finish);
        resolve();
      };
      const unsubscribe = this.#rootBus.subscribe((event) => {
        if (settled) return;
        if (event.method !== "lifecycle") return;
        if (event.params.namespace.length !== 0) return;
        const lifecycle = (event as LifecycleEvent).params.data as {
          event?: string;
        };
        if (
          lifecycle?.event === "completed" ||
          lifecycle?.event === "failed" ||
          lifecycle?.event === "interrupted"
        ) {
          finish();
        }
      });
      if (signal.aborted) {
        finish();
      } else {
        signal.addEventListener("abort", finish, { once: true });
      }
    });
  }

  #latestUnresolvedInterrupt(): ResolvedInterrupt | null {
    const thread = this.#thread;
    if (thread == null) return null;
    for (let i = thread.interrupts.length - 1; i >= 0; i -= 1) {
      const entry = thread.interrupts[i];
      if (entry == null) continue;
      if (this.#resolvedInterrupts.has(entry.interruptId)) continue;
      return {
        interruptId: entry.interruptId,
        namespace: entry.namespace,
      };
    }
    return null;
  }

  #notifyThreadListeners(): void {
    for (const listener of this.#threadListeners) listener(this.#thread);
  }
}

// ---------- helpers ----------

function bindThreadConfig(
  config: unknown,
  threadId: string
): Record<string, unknown> {
  const base =
    config != null && typeof config === "object"
      ? (config as Record<string, unknown>)
      : {};
  const configurable =
    base.configurable != null && typeof base.configurable === "object"
      ? (base.configurable as Record<string, unknown>)
      : {};
  return {
    ...base,
    configurable: {
      ...configurable,
      thread_id: threadId,
    },
  };
}

function extractAndCoerceMessages(
  values: Record<string, unknown>,
  messagesKey: string
): BaseMessage[] {
  const raw = values[messagesKey];
  if (!Array.isArray(raw)) return [];
  return ensureMessageInstances(
    raw as (Message | BaseMessage)[]
  ) as BaseMessage[];
}

function appendToolCall(
  current: AssembledToolCall[],
  next: AssembledToolCall
): AssembledToolCall[] {
  const idx = current.findIndex((c) => c.callId === next.callId);
  if (idx < 0) return [...current, next];
  const out = current.slice();
  out[idx] = next;
  return out;
}

/**
 * Stable string key for a `namespace` tuple. Uses `\u0000` as the
 * segment separator so it can't collide with a legitimate namespace
 * segment (which protocol-side is always a printable identifier).
 */
function namespaceKey(namespace: readonly string[]): string {
  return namespace.join("\u0000");
}

// Unused import guard — `AIMessage` is only referenced by type tests.
void AIMessage;

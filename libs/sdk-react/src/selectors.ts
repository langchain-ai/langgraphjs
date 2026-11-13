/* __LC_ALLOW_ENTRYPOINT_SIDE_EFFECTS__ */

"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { BaseMessage } from "@langchain/core/messages";
import {
  ensureMessageInstances,
  type AssembledToolCall,
  type ChannelEvent,
  type InferAssembledToolCalls,
  type InferStateType,
} from "@langchain/langgraph-sdk/ui";
import { bindingOf } from "./use-stream.js";
import {
  EMPTY_VIEW,
  engineOf,
  releaseLater,
  resolveNamespace,
  scopeKeyOf,
  subscribeScope,
  type ScopeHandle,
  type ScopeView,
  type SelectorTarget,
  type StreamLike,
} from "./use-scoped.js";
import type {
  Channel,
  Event,
  MessageMetadata,
  SubmissionQueueEntry,
  SubmissionQueueSnapshot,
} from "./types.js";

/** The state a stream's `values` holds, from its type. */
type StateOf<Stream extends StreamLike> =
  NonNullable<Stream["~stateType"]> extends infer State extends object
    ? State
    : Record<string, unknown>;

const EMPTY_EVENTS: Event[] = [];
const NOT_SUBSCRIBED = () => () => {};

/** The target's view while mounted, or `undefined` for the main conversation. */
function useScope(
  stream: StreamLike,
  target: SelectorTarget
): ScopeView | undefined {
  const engine = engineOf(stream);
  const key = scopeKeyOf(target);
  const [held, setHeld] = useState<{ key: string; handle: ScopeHandle }>();
  // Keyed by `key`, not `target`: a new snapshot of the same subagent keeps its scope.
  useEffect(() => {
    if (key == null) return undefined;
    const handle = subscribeScope(stream, target);
    setHeld({ key, handle });
    return () => {
      releaseLater(handle.release);
      setHeld(undefined);
    };
  }, [engine, key]);
  // Until the effect swaps handles, the previous target's view would show.
  const handle = held != null && held.key === key ? held.handle : undefined;
  const view = useSyncExternalStore(
    handle?.subscribe ?? NOT_SUBSCRIBED,
    () => handle?.getSnapshot() ?? EMPTY_VIEW,
    () => EMPTY_VIEW
  );
  return key == null ? undefined : view;
}

/**
 * The messages of the main conversation, or of a subagent or subgraph, as
 * `BaseMessage` instances. A subagent's or subgraph's stream while the hook
 * is mounted, and its connection closes when the last hook on it unmounts.
 */
export function useMessages(
  stream: StreamLike,
  target?: SelectorTarget
): BaseMessage[] {
  return useScope(stream, target)?.messages ?? stream.messages;
}

/**
 * The tool calls of the main conversation, or of a subagent or subgraph,
 * with their results. Pass an agent or a tool list as `T` to type them.
 */
export function useToolCalls(
  stream: StreamLike,
  target?: SelectorTarget
): AssembledToolCall[];
export function useToolCalls<T>(
  stream: StreamLike,
  target?: SelectorTarget
): InferAssembledToolCalls<T>[];
export function useToolCalls(
  stream: StreamLike,
  target?: SelectorTarget
): AssembledToolCall[] {
  return useScope(stream, target)?.toolCalls ?? stream.toolCalls;
}

/**
 * The latest state of the main conversation, typed from the stream, or of a
 * subagent or subgraph, whose shape you annotate:
 * `useValues<SubagentState>(stream, subagent)`. Its messages are
 * `BaseMessage` instances.
 */
export function useValues<Stream extends StreamLike>(
  stream: Stream
): StateOf<Stream>;
export function useValues<T>(stream: StreamLike): InferStateType<T>;
export function useValues<T = unknown>(
  stream: StreamLike,
  target: SelectorTarget,
  options?: { messagesKey?: string }
): T | undefined;
export function useValues(
  stream: StreamLike,
  target?: SelectorTarget,
  options?: { messagesKey?: string }
): unknown {
  const values = useScope(stream, target)?.values;
  const messagesKey = options?.messagesKey ?? "messages";
  const scoped = useMemo(() => {
    const messages = values?.[messagesKey];
    return Array.isArray(messages)
      ? { ...values, [messagesKey]: ensureMessageInstances(messages) }
      : values;
  }, [values, messagesKey]);
  return scopeKeyOf(target) == null ? stream.values : scoped;
}

/**
 * Whether an event is the target's own. The subagents and subgraphs it starts
 * stream one level below it, and only their `lifecycle` events count, so the
 * main conversation sees them start and end.
 */
function isTargetEvent(
  event: ChannelEvent,
  target: readonly string[]
): boolean {
  const { namespace } = event.params;
  const below = namespace.length - target.length;
  return (
    (below === 0 || (below === 1 && event.method === "lifecycle")) &&
    target.every((segment, i) => namespace[i] === segment)
  );
}

/**
 * Calls `onEvent` with each event of `channels` at the target's namespace, and
 * with the `lifecycle` events one level below it.
 */
function useChannelListener(
  stream: StreamLike,
  channels: readonly Channel[],
  target: SelectorTarget,
  enabled: boolean,
  onEvent: (event: Event) => void
): void {
  const engine = engineOf(stream);
  const latest = useRef(onEvent);
  latest.current = onEvent;
  const channelKey = [...channels].sort().join(",");
  const key = scopeKeyOf(target);
  useEffect(() => {
    if (!enabled) return undefined;
    const wanted = new Set<string>(channelKey.split(","));
    if (wanted.has("tools")) engine.trackStreamMode("tools");
    let stop: (() => void) | undefined;
    let done = false;
    void resolveNamespace(engine, target).then((namespace) => {
      if (done || namespace == null) return;
      // A filtered run streams a subagent's events only to its scope.
      const scope =
        namespace.length > 0 ? engine.scopes.acquire(namespace) : undefined;
      const off = engine.onChannelEvent((event) => {
        if (wanted.has(event.method) && isTargetEvent(event, namespace)) {
          latest.current(event as Event);
        }
      });
      stop = () => {
        off();
        if (scope != null) releaseLater(scope.release);
      };
    });
    return () => {
      done = true;
      stop?.();
    };
  }, [engine, channelKey, key, enabled]);
}

export interface UseChannelOptions {
  /**
   * The most events kept, the oldest dropped first.
   *
   * @default 4096
   */
  bufferSize?: number;
  /**
   * @deprecated Has no effect. The buffer collects events from when the hook
   * mounts, where 1.x also replayed the run's earlier events.
   */
  replay?: boolean;
}

/**
 * The events of `channels` at a target's namespace since the hook mounted,
 * and the `lifecycle` events of the subagents and subgraphs it starts.
 * Cleared when the stream moves to another thread.
 * For messages, tool calls and values, prefer {@link useMessages},
 * {@link useToolCalls} and {@link useValues}. A `tools` channel adds that
 * stream mode to the runs that start after it mounts, so a run already
 * streaming sends it no tool events.
 */
export function useChannel(
  stream: StreamLike,
  channels: readonly Channel[],
  target?: SelectorTarget,
  options?: UseChannelOptions
): Event[] {
  const bufferSize = options?.bufferSize ?? 4096;
  const [buffer, setBuffer] = useState({
    threadId: stream.threadId,
    events: EMPTY_EVENTS,
  });
  useChannelListener(stream, channels, target, true, (event) => {
    const threadId = engineOf(stream).threadId ?? null;
    setBuffer((previous) => {
      const events = previous.threadId === threadId ? previous.events : [];
      return {
        threadId,
        events: [
          ...events.slice(Math.max(0, events.length - bufferSize + 1)),
          event,
        ],
      };
    });
  });
  return buffer.threadId === stream.threadId ? buffer.events : EMPTY_EVENTS;
}

export interface UseChannelEffectOptions {
  /** Called with each event, from when the hook mounts. */
  onEvent: (event: Event) => void;
  /** Called when `onEvent` throws. Without it, the error is logged. */
  onError?: (error: unknown) => void;
  /** A subagent, a subgraph or a namespace. Defaults to the main conversation. */
  target?: SelectorTarget;
  /**
   * Whether events are delivered.
   *
   * @default true
   */
  enabled?: boolean;
  /**
   * @deprecated Has no effect. Events arrive from when the hook mounts,
   * where 1.x also replayed the run's earlier events.
   */
  replay?: boolean;
  /** @deprecated Has no effect. */
  bufferSize?: number;
}

/**
 * Calls `onEvent` with each event of `channels`, for side effects such as
 * analytics. The callbacks may change between renders without
 * resubscribing. A `tools` channel adds that stream mode to the runs that
 * start after it mounts, so a run already streaming sends it no tool events.
 */
export function useChannelEffect(
  stream: StreamLike,
  channels: readonly Channel[],
  options: UseChannelEffectOptions
): void {
  useChannelListener(
    stream,
    channels,
    options.target,
    options.enabled ?? true,
    (event) => {
      try {
        options.onEvent(event);
      } catch (error) {
        if (options.onError == null) throw error;
        options.onError(error);
      }
    }
  );
}

/**
 * A message's metadata: `parentCheckpointId`, the checkpoint to fork from to
 * edit it, and `optimisticStatus`. Fork points are read while a hook is
 * mounted, and arrive when a run ends:
 *
 * ```tsx
 * const { parentCheckpointId } = useMessageMetadata(stream, message.id) ?? {};
 * if (parentCheckpointId) await stream.submit(input, { forkFrom: parentCheckpointId });
 * ```
 */
export function useMessageMetadata(
  stream: StreamLike,
  messageId: string | undefined
): MessageMetadata | undefined {
  const engine = engineOf(stream);
  useEffect(() => engine.trackMessageMetadata(), [engine]);
  const { subscribe, getSnapshot } = engine.messageMetadataStore;
  const metadata = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return messageId == null ? undefined : metadata.get(messageId);
}

export interface UseSubmissionQueueReturn<
  StateType extends object = Record<string, unknown>,
> {
  readonly entries: SubmissionQueueSnapshot<StateType>;
  readonly size: number;
  /** Remove an entry, and cancel its run when it waits on the server. */
  cancel(id: string): Promise<boolean>;
  /** Remove every entry. */
  clear(): Promise<void>;
}

/** The submits waiting for the run in flight, oldest first. */
export function useSubmissionQueue<Stream extends StreamLike>(
  stream: Stream
): UseSubmissionQueueReturn<StateOf<Stream>>;
export function useSubmissionQueue(
  stream: StreamLike
): UseSubmissionQueueReturn {
  const engine = engineOf(stream);
  const binding = bindingOf(engine);
  // The engine changes its queue in place, so the ids tell when it changed.
  const queuedIds = () => engine.queueEntries.map(({ id }) => id).join(" ");
  const ids = useSyncExternalStore(binding.subscribe, queuedIds, queuedIds);
  return useMemo(() => {
    const entries = engine.queueEntries.map((entry) => ({
      id: entry.id,
      runId: binding.queue === "server" ? entry.id : undefined,
      values: entry.values,
      options: entry.options as SubmissionQueueEntry["options"],
      createdAt: entry.createdAt,
    }));
    return {
      entries,
      size: entries.length,
      cancel: (id: string) => engine.cancelQueueItem(id),
      clear: () => engine.clearQueue(),
    };
  }, [engine, binding, ids]);
}

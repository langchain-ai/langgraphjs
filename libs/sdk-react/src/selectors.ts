/* __LC_ALLOW_ENTRYPOINT_SIDE_EFFECTS__ */

"use client";

import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { BaseMessage } from "@langchain/core/messages";
import type {
  MessageMetadata,
  MessageMetadataMap,
  SubmissionQueueEntry,
  SubmissionQueueSnapshot,
} from "@langchain/langgraph-sdk/stream";
import {
  NAMESPACE_SEPARATOR,
  acquireChannelEffect,
  audioProjection,
  channelProjection,
  extensionProjection,
  filesProjection,
  imagesProjection,
  messagesProjection,
  toolCallsProjection,
  valuesProjection,
  videoProjection,
  type AssembledToolCall,
  type AudioMedia,
  type Channel,
  type ChannelEffectOptions,
  type ChannelProjectionOptions,
  type Event,
  type FileMedia,
  type ImageMedia,
  type InferToolCalls,
  type InferStateType,
  type SubagentDiscoverySnapshot,
  type SubgraphDiscoverySnapshot,
  type VideoMedia,
} from "@langchain/langgraph-sdk/stream";
import {
  getRegistry,
  STREAM_CONTROLLER,
  type AnyStream,
  type UseStreamReturn,
} from "./use-stream.js";
import { useProjection } from "./use-projection.js";

/**
 * Selector hooks don't need to carry `InterruptType` /
 * `ConfigurableType` — they only ever read state. Accepting a
 * `StateType`-parameterised stream (with the other two generics
 * widened to `any`) lets callers keep their full
 * `useStream<State, Interrupt, Configurable>()` handle
 * without re-declaring the interrupt / configurable shapes at every
 * selector call site.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type StreamHandle<StateType extends object> = UseStreamReturn<
  StateType,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  any
>;

/**
 * What a selector hook can be targeted at. Callers can pass any of:
 *  - `undefined`                      — root namespace (cheap: served by the always-on root store)
 *  - a {@link SubagentDiscoverySnapshot}  — the snapshot returned by `stream.subagents.get(...)`
 *  - a {@link SubgraphDiscoverySnapshot}  — the snapshot returned by `stream.subgraphs.get(...)`
 *  - an explicit `{ namespace: string[] }` — any other namespaced scope
 *  - a raw `string[]`                  — escape hatch identical to the object form
 */
export type SelectorTarget =
  | undefined
  | null
  | readonly string[]
  | { namespace: readonly string[] }
  | SubagentDiscoverySnapshot
  | SubgraphDiscoverySnapshot;

function resolveNamespace(target: SelectorTarget): readonly string[] {
  if (target == null) return EMPTY_NAMESPACE;
  if (Array.isArray(target)) return target;
  const obj = target as { namespace?: readonly string[] };
  return obj.namespace ?? EMPTY_NAMESPACE;
}

/**
 * If `target` is a subagent snapshot still on its default
 * `tools:<toolCallId>` namespace, return that tool-call id so the
 * caller can trigger lazy execution-namespace resolution. Returns
 * `null` for root targets, subgraph hosts, explicit namespaces, and
 * already-promoted subagents.
 */
function subagentNeedingNamespace(target: SelectorTarget): string | null {
  if (target == null || Array.isArray(target)) return null;
  const obj = target as { id?: unknown; namespace?: readonly string[] };
  if (typeof obj.id !== "string" || !Array.isArray(obj.namespace)) return null;
  if (obj.namespace.length === 1 && obj.namespace[0] === `tools:${obj.id}`) {
    return obj.id;
  }
  return null;
}

/**
 * Lazily resolve a subagent's execution namespace on the first scoped
 * mount. Deep-agent subagents execute under a `tools:<uuid>` namespace
 * distinct from their `tools:<toolCallId>` discovery key; until that is
 * known a scoped `useMessages`/`useToolCalls` would target the wrong
 * scope. The controller de-dupes and skips already-promoted ids, so
 * this is safe to call from every consumer of the same subagent.
 */
function useResolveSubagentNamespace(
  stream: AnyStream,
  target: SelectorTarget
): void {
  const controller = stream[STREAM_CONTROLLER];
  const toolCallId = subagentNeedingNamespace(target);
  useEffect(() => {
    if (toolCallId == null) return;
    void controller.resolveSubagentNamespace(toolCallId);
  }, [controller, toolCallId]);
}

const EMPTY_NAMESPACE: readonly string[] = [];

function isRoot(namespace: readonly string[]): boolean {
  return namespace.length === 0;
}

function namespaceKey(namespace: readonly string[]): string {
  return namespace.join(NAMESPACE_SEPARATOR);
}

// The stream type we accept for selectors — the public {@link AnyStream}
// erased handle. It overrides the generic-computed covariant members
// (`toolCalls`, `values`, `~stateType`) with their widest forms so a
// concrete `useStream<typeof agent>()` handle flows in without an
// `as AnyStream` cast (a bare `UseStreamReturn<any, any, any>` does not
// — see the `AnyStream` definition in `use-stream.ts`).
//
// Typed selectors (`useValues<S>` etc.) use {@link StreamHandle} above
// so the concrete `StateType` flows into the return; hooks that don't
// depend on state (`useMessages`, `useAudio`, …) stay on `AnyStream`
// for maximum flexibility.

/**
 * Subscribe to a scoped `messages` stream. Pass `stream` and
 * optionally a subagent/subgraph snapshot (or any namespaced target).
 *
 * Contract:
 *  - At the root (no target) this returns `stream.messages` directly
 *    — no extra subscription is opened. `stream.messages` is the
 *    live merge of `messages`-channel token deltas and
 *    `values.messages` snapshots (see
 *    {@link UseStreamReturn.messages}), so token-by-token
 *    streaming here depends on the backend emitting `messages`
 *    channel events. Backends that only emit `values` updates will
 *    render full turns at once rather than streaming.
 *  - For any other namespace, the mount triggers a ref-counted
 *    `messages` subscription scoped to that namespace. Unmounting
 *    the last component that watches this namespace closes the
 *    subscription automatically.
 *
 * Messages are always `BaseMessage` class instances from
 * `@langchain/core/messages`.
 */
export function useMessages(
  stream: AnyStream,
  target?: SelectorTarget
): BaseMessage[] {
  useResolveSubagentNamespace(stream, target);
  const namespace = resolveNamespace(target);
  const key = `messages|${namespaceKey(namespace)}`;
  const registry = isRoot(namespace) ? null : getRegistry(stream);
  const scoped = useProjection<BaseMessage[]>(
    registry,
    () => messagesProjection(namespace),
    key,
    EMPTY_MESSAGES
  );
  return isRoot(namespace) ? stream.messages : scoped;
}

const EMPTY_MESSAGES: BaseMessage[] = [];

/**
 * Subscribe to a scoped `tools` (tool-call) stream. Same target and
 * lifecycle rules as {@link useMessages}; at the root this just returns
 * `stream.toolCalls`.
 *
 * The optional generic `T` can be passed to narrow the type of
 * assembled tool calls on the returned array. Accepts either:
 *  - an agent brand (`typeof agent`) — union is derived from the
 *    agent's declared tools via {@link InferToolCalls};
 *  - an array of LangGraph tools (`typeof tools`) — union is derived
 *    from {@link InferToolCalls} (parallel to {@link ToolCallsFromTools}).
 *
 * When omitted, returns the plain `AssembledToolCall[]` union used by
 * the controller.
 */
export function useToolCalls(
  stream: AnyStream,
  target?: SelectorTarget
): AssembledToolCall[];
export function useToolCalls<T>(
  stream: AnyStream,
  target?: SelectorTarget
): InferToolCalls<T>[];
export function useToolCalls(
  stream: AnyStream,
  target?: SelectorTarget
): AssembledToolCall[] {
  useResolveSubagentNamespace(stream, target);
  const namespace = resolveNamespace(target);
  const key = `toolCalls|${namespaceKey(namespace)}`;
  const registry = isRoot(namespace) ? null : getRegistry(stream);
  const scoped = useProjection<AssembledToolCall[]>(
    registry,
    () => toolCallsProjection(namespace),
    key,
    EMPTY_TOOLCALLS
  );
  return isRoot(namespace) ? stream.toolCalls : scoped;
}

const EMPTY_TOOLCALLS: AssembledToolCall[] = [];

/**
 * Subscribe to a scoped `values` stream — most-recent state payload
 * for a namespace. Equivalent to reading `stream.values` at the root.
 *
 * When the payload carries a `messages` array, it is coerced to
 * `BaseMessage` instances to keep parity with the root projection.
 *
 * Typing:
 *  - **Root** (`useValues(stream)`): returns the `StateType` declared
 *    on the parent `useStream<State>()` — no explicit
 *    generic required. Non-nullable because the root snapshot always
 *    carries `values` (falling back to `initialValues ?? {}`).
 *  - **Scoped** (`useValues(stream, target)`): the scoped payload can
 *    have a different shape than the root state (e.g. a subagent
 *    returning its own substate). Callers should annotate the
 *    expected shape explicitly: `useValues<SubagentState>(stream, sub)`.
 *    Defaults to `unknown` when not annotated.
 */
export function useValues<StateType extends object>(
  stream: StreamHandle<StateType>
): StateType;
/**
 * Explicit-generic override. Accepts:
 *  - an agent brand or compiled graph (unwrapped via
 *    {@link InferStateType});
 *  - a plain state shape (returned as-is).
 *
 * The root-call form is non-nullable (the root snapshot is always
 * present); the scoped form returns `T | undefined` because a
 * projection may not have emitted a payload yet.
 */
export function useValues<T>(stream: AnyStream): InferStateType<T>;
export function useValues<T = unknown>(
  stream: AnyStream,
  target: SelectorTarget,
  options?: { messagesKey?: string }
): T | undefined;
export function useValues(
  stream: AnyStream,
  target?: SelectorTarget,
  options?: { messagesKey?: string }
): unknown {
  const namespace = resolveNamespace(target);
  const messagesKey = options?.messagesKey ?? "messages";
  const key = `values|${messagesKey}|${namespaceKey(namespace)}`;
  const registry = isRoot(namespace) ? null : getRegistry(stream);
  const scoped = useProjection<unknown>(
    registry,
    () => valuesProjection<unknown>(namespace, messagesKey),
    key,
    undefined
  );
  return isRoot(namespace) ? stream.values : scoped;
}

/**
 * Subscribe to a `custom:<name>` stream extension — the most-recent
 * payload emitted by the transformer, scoped to the target namespace.
 *
 * Returns only the latest value and resumes across serial runs, so it is
 * ideal for "current state" panels (progress, score, status). When you
 * need the full history of events rather than just the latest payload,
 * use {@link useChannel} instead.
 */
export function useExtension<T = unknown>(
  stream: AnyStream,
  name: string,
  target?: SelectorTarget
): T | undefined {
  const namespace = resolveNamespace(target);
  const key = `extension|${name}|${namespaceKey(namespace)}`;
  return useProjection<T | undefined>(
    getRegistry(stream),
    () => extensionProjection<T>(name, namespace),
    key,
    undefined
  );
}

/**
 * Subscribe to a scoped audio-media stream. Returns an array of
 * {@link AudioMedia} handles, one per message containing at least one
 * `AudioBlock` in the target namespace.
 *
 * Each handle is yielded on its first matching `content-block-start`,
 * exposes `.partialBytes` for live access, settles `.blob` /
 * `.objectURL` / `.transcript` on `message-finish`, and surfaces
 * fail-loud errors via `.error`.
 *
 * Pair with {@link useMediaURL} to turn a handle into an `<audio src>`.
 */
export function useAudio(
  stream: AnyStream,
  target?: SelectorTarget
): AudioMedia[] {
  const namespace = resolveNamespace(target);
  const key = `audio|${namespaceKey(namespace)}`;
  return useProjection<AudioMedia[]>(
    getRegistry(stream),
    () => audioProjection(namespace),
    key,
    EMPTY_AUDIO
  );
}

const EMPTY_AUDIO: AudioMedia[] = [];

/**
 * Subscribe to a scoped image-media stream. See {@link useAudio} for
 * shared semantics; pair with {@link useMediaURL} for `<img src>`.
 */
export function useImages(
  stream: AnyStream,
  target?: SelectorTarget
): ImageMedia[] {
  const namespace = resolveNamespace(target);
  const key = `images|${namespaceKey(namespace)}`;
  return useProjection<ImageMedia[]>(
    getRegistry(stream),
    () => imagesProjection(namespace),
    key,
    EMPTY_IMAGES
  );
}

const EMPTY_IMAGES: ImageMedia[] = [];

/**
 * Subscribe to a scoped video-media stream. See {@link useAudio} for
 * shared semantics; pair with {@link useMediaURL} for `<video src>`.
 */
export function useVideo(
  stream: AnyStream,
  target?: SelectorTarget
): VideoMedia[] {
  const namespace = resolveNamespace(target);
  const key = `video|${namespaceKey(namespace)}`;
  return useProjection<VideoMedia[]>(
    getRegistry(stream),
    () => videoProjection(namespace),
    key,
    EMPTY_VIDEO
  );
}

const EMPTY_VIDEO: VideoMedia[] = [];

/**
 * Subscribe to a scoped file-media stream. See {@link useAudio} for
 * shared semantics; pair with {@link useMediaURL} for an
 * `<a download href>` target.
 */
export function useFiles(
  stream: AnyStream,
  target?: SelectorTarget
): FileMedia[] {
  const namespace = resolveNamespace(target);
  const key = `files|${namespaceKey(namespace)}`;
  return useProjection<FileMedia[]>(
    getRegistry(stream),
    () => filesProjection(namespace),
    key,
    EMPTY_FILES
  );
}

const EMPTY_FILES: FileMedia[] = [];

export type UseChannelOptions = ChannelProjectionOptions;

/**
 * Raw-events escape hatch. Subscribes to one or more channels at a
 * namespace and returns a bounded buffer of raw protocol events.
 *
 * The buffer keeps accumulating across serial runs for the lifetime of
 * the thread, so this is the hook to use for an event log / stream of a
 * custom channel (e.g. `["custom:redaction-stats"]`). When you only need
 * the latest payload of a single `custom:<name>` channel, prefer
 * {@link useExtension}. For the common message/tool/value cases prefer
 * {@link useMessages} / {@link useToolCalls} / {@link useValues}.
 */
export function useChannel(
  stream: AnyStream,
  channels: readonly Channel[],
  target?: SelectorTarget,
  options?: UseChannelOptions
): Event[] {
  const namespace = resolveNamespace(target);
  const channelKey = useMemo(() => [...channels].sort().join(","), [channels]);
  const key = `channel|${options?.bufferSize ?? "default"}|${(options?.replay ?? true) ? "replay" : "live"}|${channelKey}|${namespaceKey(namespace)}`;
  return useProjection<Event[]>(
    getRegistry(stream),
    () => channelProjection(channels, namespace, options),
    key,
    EMPTY_EVENTS
  );
}

const EMPTY_EVENTS: Event[] = [];

/**
 * Options for {@link useChannelEffect}. Extends the projection options
 * (`bufferSize`, `replay`) with the per-event callback, an optional
 * error sink, a `target` scope, and an `enabled` gate.
 */
export interface UseChannelEffectOptions extends ChannelEffectOptions {
  /**
   * Scope events to a subagent / subgraph / explicit namespace.
   * Defaults to the root namespace.
   */
  target?: SelectorTarget;
  /**
   * Gate the subscription. When `false`, no subscription is opened and
   * no events are delivered. Defaults to `true`. Flipping this lets you
   * pause analytics (e.g. while the user is viewing a different thread)
   * without unmounting.
   */
  enabled?: boolean;
}

/**
 * Side-effect counterpart to {@link useChannel}. Instead of returning a
 * buffer of events that re-renders the component, it invokes `onEvent`
 * once per event for as long as the hook is mounted — the idiomatic
 * place for analytics, logging, and other fire-and-forget side effects.
 *
 * ```tsx
 * useChannelEffect(stream, ["lifecycle", "tools"], {
 *   replay: false,
 *   onEvent(event) {
 *     sendAnalytics(event);
 *   },
 *   onError(error) {
 *     logger.error(error);
 *   },
 * });
 * ```
 *
 * Notes:
 *  - `onEvent` / `onError` are read from a ref, so passing a fresh
 *    closure each render is fine — it never re-subscribes.
 *  - The underlying subscription is shared (ref-counted) with any
 *    matching {@link useChannel} consumer, so you only ever pay for one
 *    server subscription per channel set.
 *  - `replay` defaults to `false` (live-only). Set it to `true` only if
 *    you genuinely want to (re)process replayed history.
 *  - Events buffered before the hook mounts are not re-delivered.
 */
export function useChannelEffect(
  stream: AnyStream,
  channels: readonly Channel[],
  options: UseChannelEffectOptions
): void {
  const {
    target,
    enabled = true,
    replay,
    bufferSize,
    onEvent,
    onError,
  } = options;

  // Keep the latest callbacks in refs so re-renders that pass new inline
  // closures never tear down and re-open the subscription.
  const onEventRef = useRef(onEvent);
  const onErrorRef = useRef(onError);
  onEventRef.current = onEvent;
  onErrorRef.current = onError;

  useResolveSubagentNamespace(stream, target);

  const namespace = resolveNamespace(target);
  const channelKey = useMemo(() => [...channels].sort().join(","), [channels]);
  const key = `channelEffect|${bufferSize ?? "default"}|${
    (replay ?? false) ? "replay" : "live"
  }|${channelKey}|${namespaceKey(namespace)}`;

  const registry = getRegistry(stream);

  useEffect(() => {
    if (!enabled || registry == null) return undefined;
    return acquireChannelEffect(registry, channels, namespace, {
      replay,
      bufferSize,
      onEvent: (event) => onEventRef.current(event),
      onError: (error) => onErrorRef.current?.(error),
    });
    // `channels` / `namespace` / `replay` / `bufferSize` are folded into
    // `key`; callbacks live in refs. Re-subscribe only when the resolved
    // scope or `enabled` changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registry, key, enabled]);
}

/**
 * Read metadata recorded for a specific message id — today exposes
 * `parentCheckpointId`, the checkpoint the message was first seen on.
 * Designed for fork / edit flows:
 *
 * ```tsx
 * const { parentCheckpointId } = useMessageMetadata(stream, msg.id) ?? {};
 * if (parentCheckpointId) {
 *   await stream.submit(input, { forkFrom: parentCheckpointId });
 * }
 * ```
 *
 * Returns `undefined` when the id isn't known yet (e.g. the server
 * hasn't emitted `parent_checkpoint` for that message, or the message
 * arrived via `messages`-channel deltas only and no `values` snapshot
 * has landed for it yet).
 */
export function useMessageMetadata(
  stream: AnyStream,
  messageId: string | undefined
): MessageMetadata | undefined {
  const store = stream[STREAM_CONTROLLER].messageMetadataStore;
  const snapshot = useSyncExternalStore<MessageMetadataMap>(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot
  );
  return messageId == null ? undefined : snapshot.get(messageId);
}

/**
 * Reactive handle on the server-side submission queue.
 *
 * Populated when `submit()` is invoked with `multitaskStrategy:
 * "enqueue"` while another run is in flight. The returned object is
 * stable per snapshot so consumers can pass `entries` straight into a
 * `<Fragment key={e.id}>` list without extra memoisation.
 */
export interface UseSubmissionQueueReturn<
  StateType extends object = Record<string, unknown>,
> {
  readonly entries: SubmissionQueueSnapshot<StateType>;
  readonly size: number;
  cancel(id: string): Promise<boolean>;
  clear(): Promise<void>;
}

export function useSubmissionQueue<StateType extends object>(
  stream: StreamHandle<StateType>
): UseSubmissionQueueReturn<StateType>;
export function useSubmissionQueue(stream: AnyStream): UseSubmissionQueueReturn;
export function useSubmissionQueue(
  stream: AnyStream
): UseSubmissionQueueReturn {
  const controller = stream[STREAM_CONTROLLER];
  const store = controller.queueStore;
  const entries = useSyncExternalStore<SubmissionQueueSnapshot>(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot
  );
  return useMemo<UseSubmissionQueueReturn>(
    () => ({
      entries,
      size: entries.length,
      cancel: (id) => controller.cancelQueued(id),
      clear: () => controller.clearQueue(),
    }),
    [entries, controller]
  );
}

export type { SubmissionQueueEntry, SubmissionQueueSnapshot };

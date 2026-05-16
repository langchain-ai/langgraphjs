/* __LC_ALLOW_ENTRYPOINT_SIDE_EFFECTS__ */

"use client";

import { useMemo, useSyncExternalStore } from "react";
import type { BaseMessage } from "@langchain/core/messages";
import type {
  MessageMetadata,
  MessageMetadataMap,
  SubmissionQueueEntry,
  SubmissionQueueSnapshot,
} from "@langchain/langgraph-sdk/stream";
import {
  NAMESPACE_SEPARATOR,
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
  type ChannelProjectionOptions,
  type Event,
  type FileMedia,
  type ImageMedia,
  type InferStateType,
  type SubagentDiscoverySnapshot,
  type SubgraphDiscoverySnapshot,
  type VideoMedia,
} from "@langchain/langgraph-sdk/stream";
import {
  getRegistry,
  STREAM_CONTROLLER,
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

const EMPTY_NAMESPACE: readonly string[] = [];

function isRoot(namespace: readonly string[]): boolean {
  return namespace.length === 0;
}

function namespaceKey(namespace: readonly string[]): string {
  return namespace.join(NAMESPACE_SEPARATOR);
}

// The stream type we accept for selectors — purposely loose so
// selector hooks remain callable from components that don't carry
// the exact State/Interrupt/Configurable generics. We use `any` for
// all three generics because `UseStreamReturn` is
// invariant in `State` and `Configurable` (they flow through both
// reader and writer positions), so a concrete
// `useStream<typeof agent>()` handle wouldn't flow into
// a `<object, unknown, object>` slot otherwise.
//
// Typed selectors (`useValues<S>` etc.) use {@link StreamHandle}
// above so the concrete `StateType` flows into the return; hooks
// that don't depend on state (`useMessages`, `useAudio`, …) stay on
// `AnyStream` for maximum flexibility.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyStream = UseStreamReturn<any, any, any>;

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
 * `toolCall.args` on the returned array. Accepts either:
 *  - an agent brand (`typeof agent`) — union is derived from the
 *    agent's declared tools;
 *  - an array of LangGraph tools (`typeof tools`) — union is derived
 *    from `ToolCallFromTool<T[number]>`;
 *  - any direct `DefaultToolCall` shape.
 *
 * When omitted, returns the plain `AssembledToolCall[]` union used by
 * the controller.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function useToolCalls(
  stream: AnyStream,
  target?: SelectorTarget
): AssembledToolCall[];
export function useToolCalls(
  stream: AnyStream,
  target?: SelectorTarget
): AssembledToolCall[];
export function useToolCalls(
  stream: AnyStream,
  target?: SelectorTarget
): AssembledToolCall[] {
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
 * Subscribe to a `custom:<name>` stream extension — most-recent
 * payload emitted by the transformer, scoped to the target namespace.
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
 * Raw-events escape hatch. Subscribes to one or more channels at a
 * namespace and returns a bounded buffer of raw protocol events.
 * Prefer {@link useMessages} / {@link useToolCalls} / {@link useValues}
 * for the common cases.
 */
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
 * Read metadata recorded for a specific message id — today exposes
 * `parentCheckpointId`, the checkpoint the message was first seen on.
 * Designed for fork / edit flows:
 *
 * ```tsx
 * const { parentCheckpointId } = useMessageMetadata(stream, msg.id) ?? {};
 * if (parentCheckpointId) {
 *   await stream.submit(input, { forkFrom: { checkpointId: parentCheckpointId } });
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
 *
 * Today the queue is maintained client-side; once the server starts
 * emitting a dedicated queue channel (roadmap A0.3) the controller
 * will mirror that state directly — the hook surface will not change.
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

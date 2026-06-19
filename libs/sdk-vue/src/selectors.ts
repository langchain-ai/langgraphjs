import {
  computed,
  onScopeDispose,
  readonly,
  shallowRef,
  toValue,
  watch,
  watchEffect,
  type ComputedRef,
  type MaybeRefOrGetter,
  type ShallowRef,
} from "vue";
import type { BaseMessage } from "@langchain/core/messages";
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
  type MessageMetadata,
  type MessageMetadataMap,
  type SubagentDiscoverySnapshot,
  type SubgraphDiscoverySnapshot,
  type SubmissionQueueEntry,
  type SubmissionQueueSnapshot,
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
 * Selector composables don't need to carry `InterruptType` /
 * `ConfigurableType`. Parameterising on `StateType` alone lets
 * callers with a full `useStream<S, I, C>()` handle pass it in without
 * redeclaring those generics at every call site.
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
 * What a selector composable can be targeted at. Callers can pass:
 *  - `undefined` / `null` — root namespace (served by the always-on
 *    root store — no extra subscription);
 *  - a {@link SubagentDiscoverySnapshot} (`stream.subagents.value.get(...)`);
 *  - a {@link SubgraphDiscoverySnapshot} (`stream.subgraphs.value.get(...)`);
 *  - an explicit `{ namespace: string[] }`;
 *  - a raw `string[]` escape hatch.
 */
export type SelectorTarget =
  | undefined
  | null
  | readonly string[]
  | { namespace: readonly string[] }
  | SubagentDiscoverySnapshot
  | SubgraphDiscoverySnapshot;

const EMPTY_NAMESPACE: readonly string[] = [];

function resolveNamespace(target: SelectorTarget): readonly string[] {
  if (target == null) return EMPTY_NAMESPACE;
  if (Array.isArray(target)) return target as readonly string[];
  const obj = target as { namespace?: readonly string[] };
  return obj.namespace ?? EMPTY_NAMESPACE;
}

function isRoot(namespace: readonly string[]): boolean {
  return namespace.length === 0;
}

/**
 * If `target` is a subagent snapshot still on its default
 * `tools:<toolCallId>` namespace, return that tool-call id. See the
 * React selectors for the rationale (deep-agent subagents execute under
 * a distinct `tools:<uuid>` namespace resolved lazily from history).
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
 * Lazily resolve a subagent's execution namespace on first scoped use.
 * Re-evaluates if `target` changes; the controller de-dupes and skips
 * already-promoted ids so this is cheap to call from every consumer.
 */
function useResolveSubagentNamespace(
  stream: AnyStream,
  target?: MaybeRefOrGetter<SelectorTarget>
): void {
  const controller = stream[STREAM_CONTROLLER];
  watchEffect(() => {
    const id = subagentNeedingNamespace(toValue(target));
    if (id != null) void controller.resolveSubagentNamespace(id);
  });
}

function namespaceKey(namespace: readonly string[]): string {
  return namespace.join(NAMESPACE_SEPARATOR);
}

/**
 * Subscribe to a scoped `messages` stream.
 *
 * Contract:
 *  - At the root (no `target`) this returns `stream.messages` — the
 *    always-on root projection; no extra subscription is opened.
 *  - For any non-root namespace, mount triggers a ref-counted
 *    `messages` subscription scoped to that namespace. The
 *    subscription is released automatically when the calling scope
 *    disappears (and the registry closes the underlying server
 *    subscription when the last consumer leaves).
 *
 * Messages are always `BaseMessage` class instances from
 * `@langchain/core/messages`.
 */
export function useMessages(
  stream: AnyStream,
  target?: MaybeRefOrGetter<SelectorTarget>
): Readonly<ShallowRef<BaseMessage[]>> {
  useResolveSubagentNamespace(stream, target);
  const namespace = computed(() => resolveNamespace(toValue(target)));
  if (isRoot(namespace.value)) return stream.messages;
  const key = computed(() => `messages|${namespaceKey(namespace.value)}`);
  return useProjection<BaseMessage[]>(
    getRegistry(stream),
    () => messagesProjection(namespace.value),
    key,
    EMPTY_MESSAGES
  );
}

const EMPTY_MESSAGES: BaseMessage[] = [];

/**
 * Subscribe to a scoped `tools` (tool-call) stream. Same target and
 * lifecycle rules as {@link useMessages}; at the root this returns
 * `stream.toolCalls` directly.
 */
export function useToolCalls(
  stream: AnyStream,
  target?: MaybeRefOrGetter<SelectorTarget>
): Readonly<ShallowRef<AssembledToolCall[]>>;
export function useToolCalls<T>(
  stream: AnyStream,
  target?: MaybeRefOrGetter<SelectorTarget>
): Readonly<ShallowRef<InferToolCalls<T>[]>>;
export function useToolCalls(
  stream: AnyStream,
  target?: MaybeRefOrGetter<SelectorTarget>
): Readonly<ShallowRef<AssembledToolCall[]>> {
  useResolveSubagentNamespace(stream, target);
  const namespace = computed(() => resolveNamespace(toValue(target)));
  if (isRoot(namespace.value)) return stream.toolCalls;
  const key = computed(() => `toolCalls|${namespaceKey(namespace.value)}`);
  return useProjection<AssembledToolCall[]>(
    getRegistry(stream),
    () => toolCallsProjection(namespace.value),
    key,
    EMPTY_TOOLCALLS
  );
}

const EMPTY_TOOLCALLS: AssembledToolCall[] = [];

/**
 * Subscribe to a scoped `values` stream — the most recent state
 * payload for a namespace. At the root returns `stream.values`.
 *
 * Typing:
 *  - **Root** (`useValues(stream)`): returns the `StateType` declared
 *    on `useStream<State>()` — non-nullable (the root snapshot always
 *    has values, falling back to `initialValues ?? {}`).
 *  - **Scoped** (`useValues(stream, target)`): scoped payloads can
 *    differ from the root state; callers should annotate the
 *    expected shape explicitly (`useValues<SubagentState>(stream,
 *    sub)`). Defaults to `unknown` when not annotated.
 */
export function useValues<StateType extends object>(
  stream: StreamHandle<StateType>
): Readonly<ShallowRef<StateType>>;
export function useValues<T>(
  stream: AnyStream
): Readonly<ShallowRef<InferStateType<T>>>;
export function useValues<T = unknown>(
  stream: AnyStream,
  target: SelectorTarget,
  options?: { messagesKey?: string }
): Readonly<ShallowRef<T | undefined>>;
export function useValues(
  stream: AnyStream,
  target?: SelectorTarget,
  options?: { messagesKey?: string }
): Readonly<ShallowRef<unknown>> {
  const namespace = resolveNamespace(target);
  if (isRoot(namespace)) return stream.values as Readonly<ShallowRef<unknown>>;
  const messagesKey = options?.messagesKey ?? "messages";
  const key = `values|${messagesKey}|${namespaceKey(namespace)}`;
  return useProjection<unknown>(
    getRegistry(stream),
    () => valuesProjection<unknown>(namespace, messagesKey),
    key,
    undefined
  );
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
): Readonly<ShallowRef<T | undefined>> {
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
 *
 * The buffer keeps accumulating across serial runs for the lifetime of
 * the thread, so this is the hook to use for an event log / stream of a
 * custom channel (e.g. `["custom:redaction-stats"]`). When you only need
 * the latest payload of a single `custom:<name>` channel, prefer
 * {@link useExtension}. For the common message/tool/value cases prefer
 * {@link useMessages} / {@link useToolCalls} / {@link useValues}.
 */
export type UseChannelOptions = ChannelProjectionOptions;

export function useChannel(
  stream: AnyStream,
  channels: readonly Channel[],
  target?: SelectorTarget,
  options?: UseChannelOptions
): Readonly<ShallowRef<Event[]>> {
  const namespace = resolveNamespace(target);
  const sortedChannels = [...channels].sort().join(",");
  const key = `channel|${options?.bufferSize ?? "default"}|${(options?.replay ?? true) ? "replay" : "live"}|${sortedChannels}|${namespaceKey(namespace)}`;
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
 * error sink, a reactive `target` scope, and a reactive `enabled` gate.
 */
export interface UseChannelEffectOptions extends ChannelEffectOptions {
  /**
   * Scope events to a subagent / subgraph / explicit namespace.
   * Defaults to the root namespace. Accepts a ref/getter so reactive
   * state can drive the scope.
   */
  target?: MaybeRefOrGetter<SelectorTarget>;
  /**
   * Gate the subscription. When `false`, no subscription is opened and
   * no events are delivered. Defaults to `true`. Accepts a ref/getter.
   */
  enabled?: MaybeRefOrGetter<boolean>;
}

/**
 * Side-effect counterpart to {@link useChannel}. Instead of returning a
 * reactive buffer, it invokes `onEvent` once per event for as long as
 * the calling scope is alive — the idiomatic place for analytics,
 * logging, and other fire-and-forget side effects.
 *
 * ```ts
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
 * Reactive `channels` / `target` / `enabled` re-bind the subscription
 * when they change. The underlying subscription is shared (ref-counted)
 * with any matching {@link useChannel} consumer. `replay` defaults to
 * `false` (live-only); events buffered before the effect attaches are
 * not re-delivered.
 *
 * Must be called from a component `setup()` (or another effect scope) so
 * the subscription is torn down on `onScopeDispose`.
 */
export function useChannelEffect(
  stream: AnyStream,
  channels: MaybeRefOrGetter<readonly Channel[]>,
  options: UseChannelEffectOptions
): void {
  useResolveSubagentNamespace(stream, options.target);

  let dispose: (() => void) | null = null;
  const detach = () => {
    dispose?.();
    dispose = null;
  };

  watch(
    () => {
      const enabled = toValue(options.enabled) ?? true;
      const sortedChannels = [...toValue(channels)].sort().join(",");
      const namespace = resolveNamespace(toValue(options.target));
      // Return a stable string so the watcher only re-acquires when the
      // resolved scope actually changes (not on every getter call).
      return `${enabled ? "on" : "off"}|${sortedChannels}|${namespaceKey(namespace)}`;
    },
    () => {
      detach();
      const enabled = toValue(options.enabled) ?? true;
      if (!enabled) return;
      const registry = getRegistry(stream);
      if (registry == null) return;
      const resolvedChannels = toValue(channels);
      const namespace = resolveNamespace(toValue(options.target));
      dispose = acquireChannelEffect(registry, resolvedChannels, namespace, {
        replay: options.replay,
        bufferSize: options.bufferSize,
        // Read callbacks lazily so a fresh closure never re-acquires.
        onEvent: (event) => options.onEvent(event),
        onError: options.onError
          ? (error) => options.onError?.(error)
          : undefined,
      });
    },
    { immediate: true, flush: "sync" }
  );

  onScopeDispose(detach);
}

/**
 * Subscribe to a scoped audio-media stream. Each handle is yielded
 * on its first matching `content-block-start`, exposes
 * `.partialBytes` for live access, settles `.blob` / `.objectURL` /
 * `.transcript` on `message-finish`, and surfaces errors via
 * `.error`.
 */
export function useAudio(
  stream: AnyStream,
  target?: SelectorTarget
): Readonly<ShallowRef<AudioMedia[]>> {
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
 * Subscribe to a scoped image-media stream. Pair with
 * {@link useMediaURL} for `<img src>`.
 */
export function useImages(
  stream: AnyStream,
  target?: SelectorTarget
): Readonly<ShallowRef<ImageMedia[]>> {
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
 * Subscribe to a scoped video-media stream. Pair with
 * {@link useMediaURL} for `<video src>`.
 */
export function useVideo(
  stream: AnyStream,
  target?: SelectorTarget
): Readonly<ShallowRef<VideoMedia[]>> {
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
 * Subscribe to a scoped file-media stream. Pair with
 * {@link useMediaURL} for an `<a download href>` target.
 */
export function useFiles(
  stream: AnyStream,
  target?: SelectorTarget
): Readonly<ShallowRef<FileMedia[]>> {
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

/**
 * Read metadata recorded for a specific message id — today exposes
 * `parentCheckpointId`, the checkpoint the message was first seen on.
 * Designed for fork / edit flows:
 *
 * ```ts
 * const meta = useMessageMetadata(stream, () => msg.id);
 * // meta.value?.parentCheckpointId
 * ```
 *
 * `messageId` accepts a raw string, a `Ref<string | undefined>`, or
 * a getter — the binding re-evaluates whenever the id changes.
 */
export function useMessageMetadata(
  stream: AnyStream,
  messageId: MaybeRefOrGetter<string | undefined>
): ComputedRef<MessageMetadata | undefined> {
  const store = stream[STREAM_CONTROLLER].messageMetadataStore;
  const mapRef = shallowRef<MessageMetadataMap>(store.getSnapshot());
  const unsubscribe = store.subscribe(() => {
    mapRef.value = store.getSnapshot();
  });
  onScopeDispose(unsubscribe);

  return computed<MessageMetadata | undefined>(() => {
    const key = toValue(messageId);
    if (key == null) return undefined;
    return mapRef.value.get(key);
  });
}

/**
 * Reactive handle on the server-side submission queue.
 *
 * Populated when `submit()` is invoked with
 * `multitaskStrategy: "enqueue"` while another run is in flight. The
 * returned refs are shared per call — safe to pass into `v-for`.
 */
export interface UseSubmissionQueueReturn<
  StateType extends object = Record<string, unknown>,
> {
  readonly entries: Readonly<ShallowRef<SubmissionQueueSnapshot<StateType>>>;
  readonly size: ComputedRef<number>;
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
  const entries = shallowRef<SubmissionQueueSnapshot>(store.getSnapshot());
  const unsubscribe = store.subscribe(() => {
    entries.value = store.getSnapshot();
  });
  onScopeDispose(unsubscribe);

  return {
    entries: readonly(entries) as Readonly<ShallowRef<SubmissionQueueSnapshot>>,
    size: computed(() => entries.value.length),
    cancel: (id) => controller.cancelQueued(id),
    clear: () => controller.clearQueue(),
  };
}

export type { SubmissionQueueEntry, SubmissionQueueSnapshot };

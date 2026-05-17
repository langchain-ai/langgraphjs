import type { BaseMessage } from "@langchain/core/messages";
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
} from "./use-stream.svelte.js";
import {
  useProjection,
  type ReactiveValue,
  type ValueOrGetter,
} from "./use-projection.svelte.js";

/**
 * Parameterise selectors on `StateType` alone so callers with a full
 * `useStream<S, I, C>()` handle don't have to redeclare
 * `InterruptType` / `ConfigurableType` at every call site.
 */
type StreamHandle<StateType extends object> = UseStreamReturn<
  StateType,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  any
>;

/**
 * What a selector composable targets. Callers can pass:
 *  - `undefined` / `null` — root namespace (served by the always-on
 *    root store; no extra subscription opens);
 *  - a {@link SubagentDiscoverySnapshot} (`stream.subagents.get(...)`);
 *  - a {@link SubgraphDiscoverySnapshot}
 *    (`stream.subgraphs.get(...)`);
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

function namespaceKey(namespace: readonly string[]): string {
  return namespace.join(NAMESPACE_SEPARATOR);
}

function isGetter<T>(input: ValueOrGetter<T> | undefined): input is () => T {
  return typeof input === "function";
}

/**
 * Internal helper that wires a reactive-or-static target into
 * {@link useProjection}. Encapsulates the bookkeeping every selector
 * otherwise repeats.
 */
function selectFromTarget<T>(
  stream: AnyStream,
  target: ValueOrGetter<SelectorTarget> | undefined,
  initialValue: T,
  makeSpec: (
    namespace: readonly string[]
  ) => import("@langchain/langgraph-sdk/stream").ProjectionSpec<T>,
  keyPrefix: string
): ReactiveValue<T> {
  if (isGetter(target)) {
    const getTarget = target;
    return useProjection<T>(
      () => {
        const ns = resolveNamespace(getTarget());
        return isRoot(ns) ? null : getRegistry(stream);
      },
      () => makeSpec(resolveNamespace(getTarget())),
      () => `${keyPrefix}|${namespaceKey(resolveNamespace(getTarget()))}`,
      initialValue
    );
  }
  const ns = resolveNamespace(target);
  // Static root: we deliberately don't short-circuit here because
  // each selector owns the root fallback shape (`stream.messages`
  // vs `stream.values` vs `stream.toolCalls`). Callers use the
  // dedicated wrappers below.
  const key = `${keyPrefix}|${namespaceKey(ns)}`;
  return useProjection<T>(
    isRoot(ns) ? null : getRegistry(stream),
    () => makeSpec(ns),
    key,
    initialValue
  );
}

const EMPTY_MESSAGES: BaseMessage[] = [];
const EMPTY_TOOLCALLS: AssembledToolCall[] = [];
const EMPTY_EVENTS: Event[] = [];
const EMPTY_AUDIO: AudioMedia[] = [];
const EMPTY_IMAGES: ImageMedia[] = [];
const EMPTY_VIDEO: VideoMedia[] = [];
const EMPTY_FILES: FileMedia[] = [];

/**
 * Subscribe to a scoped `messages` stream.
 *
 * Contract:
 *  - At the root (no `target`, or a static target that resolves to
 *    the root namespace) returns a handle whose `.current` delegates
 *    to `stream.messages` — the always-on root projection. No extra
 *    subscription is opened.
 *  - For any non-root namespace, mount triggers a ref-counted
 *    `messages` subscription scoped to that namespace. The
 *    subscription is released automatically when the owning
 *    component teardown fires (and the registry closes the
 *    underlying server subscription when the last consumer leaves).
 *  - A reactive `target` (getter form) re-binds the subscription on
 *    change. A getter that flips between root and scoped is
 *    supported: the root case short-circuits to the initial value
 *    because dynamic root delegation isn't meaningful — pass a
 *    static undefined/null target for root handles.
 *
 * Messages are always `BaseMessage` class instances from
 * `@langchain/core/messages`.
 */
export function useMessages(
  stream: AnyStream,
  target?: ValueOrGetter<SelectorTarget>
): ReactiveValue<BaseMessage[]> {
  if (!isGetter(target)) {
    const ns = resolveNamespace(target);
    if (isRoot(ns)) {
      return {
        get current() {
          return stream.messages;
        },
      };
    }
  }
  return selectFromTarget<BaseMessage[]>(
    stream,
    target,
    EMPTY_MESSAGES,
    (ns) => messagesProjection(ns),
    "messages"
  );
}

/**
 * Subscribe to a scoped `tools` (tool-call) stream. Same target and
 * lifecycle rules as {@link useMessages}; at the root this returns a
 * handle delegating to `stream.toolCalls`.
 */
export function useToolCalls(
  stream: AnyStream,
  target?: ValueOrGetter<SelectorTarget>
): ReactiveValue<AssembledToolCall[]> {
  if (!isGetter(target)) {
    const ns = resolveNamespace(target);
    if (isRoot(ns)) {
      return {
        get current() {
          return stream.toolCalls;
        },
      };
    }
  }
  return selectFromTarget<AssembledToolCall[]>(
    stream,
    target,
    EMPTY_TOOLCALLS,
    (ns) => toolCallsProjection(ns),
    "toolCalls"
  );
}

/**
 * Subscribe to a scoped `values` stream — the most recent state
 * payload for a namespace. At the root returns a handle delegating
 * to `stream.values`.
 *
 * Typing:
 *  - **Root** (`useValues(stream)`): returns the `StateType` declared
 *    on `useStream<State>()` — non-nullable (the root snapshot
 *    always has values, falling back to `initialValues ?? {}`).
 *  - **Scoped** (`useValues(stream, target)`): scoped payloads can
 *    differ from the root state; callers should annotate the
 *    expected shape explicitly (`useValues<SubagentState>(stream,
 *    sub)`). Defaults to `unknown` when not annotated.
 */
export function useValues<StateType extends object>(
  stream: StreamHandle<StateType>
): ReactiveValue<StateType>;
export function useValues<T>(
  stream: AnyStream
): ReactiveValue<InferStateType<T>>;
export function useValues<T = unknown>(
  stream: AnyStream,
  target: ValueOrGetter<SelectorTarget>,
  options?: { messagesKey?: string }
): ReactiveValue<T | undefined>;
export function useValues(
  stream: AnyStream,
  target?: ValueOrGetter<SelectorTarget>,
  options?: { messagesKey?: string }
): ReactiveValue<unknown> {
  if (!isGetter(target)) {
    const ns = resolveNamespace(target);
    if (isRoot(ns)) {
      return {
        get current() {
          return stream.values;
        },
      };
    }
  }
  const messagesKey = options?.messagesKey ?? "messages";
  return selectFromTarget<unknown>(
    stream,
    target,
    undefined,
    (ns) => valuesProjection<unknown>(ns, messagesKey),
    `values|${messagesKey}`
  );
}

/**
 * Subscribe to a `custom:<name>` stream extension — most-recent
 * payload emitted by the transformer, scoped to the target namespace.
 *
 * `name` accepts either a plain string or a getter so component
 * state can drive the extension name at runtime.
 */
export function useExtension<T = unknown>(
  stream: AnyStream,
  name: ValueOrGetter<string>,
  target?: ValueOrGetter<SelectorTarget>
): ReactiveValue<T | undefined> {
  const getName = () => (isGetter(name) ? (name as () => string)() : name);
  if (isGetter(target)) {
    const getTarget = target;
    return useProjection<T | undefined>(
      () => getRegistry(stream),
      () => extensionProjection<T>(getName(), resolveNamespace(getTarget())),
      () =>
        `extension|${getName()}|${namespaceKey(resolveNamespace(getTarget()))}`,
      undefined
    );
  }
  const ns = resolveNamespace(target);
  return useProjection<T | undefined>(
    getRegistry(stream),
    () => extensionProjection<T>(getName(), ns),
    () => `extension|${getName()}|${namespaceKey(ns)}`,
    undefined
  );
}

/**
 * Raw-events escape hatch. Subscribes to one or more channels at a
 * namespace and returns a bounded buffer of raw protocol events.
 * Prefer {@link useMessages} / {@link useToolCalls} / {@link useValues}
 * for the common cases.
 */
export type UseChannelOptions = ChannelProjectionOptions;

export function useChannel(
  stream: AnyStream,
  channels: ValueOrGetter<readonly Channel[]>,
  target?: ValueOrGetter<SelectorTarget>,
  options?: UseChannelOptions
): ReactiveValue<Event[]> {
  const getChannels = () =>
    isGetter(channels) ? (channels as () => readonly Channel[])() : channels;
  const getTarget = () => (isGetter(target) ? target() : target);
  const bufferSize = options?.bufferSize ?? "default";
  const replayMode = (options?.replay ?? true) ? "replay" : "live";
  return useProjection<Event[]>(
    () => getRegistry(stream),
    () =>
      channelProjection(
        getChannels(),
        resolveNamespace(getTarget()),
        options
      ) as unknown as import("@langchain/langgraph-sdk/stream").ProjectionSpec<
        Event[]
      >,
    () => {
      const sortedChannels = [...getChannels()].sort().join(",");
      return `channel|${bufferSize}|${replayMode}|${sortedChannels}|${namespaceKey(resolveNamespace(getTarget()))}`;
    },
    EMPTY_EVENTS
  );
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
  target?: ValueOrGetter<SelectorTarget>
): ReactiveValue<AudioMedia[]> {
  return selectFromTarget<AudioMedia[]>(
    stream,
    target,
    EMPTY_AUDIO,
    (ns) => audioProjection(ns),
    "audio"
  );
}

/**
 * Subscribe to a scoped image-media stream. Pair with `useMediaURL`
 * for `<img src>`.
 */
export function useImages(
  stream: AnyStream,
  target?: ValueOrGetter<SelectorTarget>
): ReactiveValue<ImageMedia[]> {
  return selectFromTarget<ImageMedia[]>(
    stream,
    target,
    EMPTY_IMAGES,
    (ns) => imagesProjection(ns),
    "images"
  );
}

/**
 * Subscribe to a scoped video-media stream. Pair with `useMediaURL`
 * for `<video src>`.
 */
export function useVideo(
  stream: AnyStream,
  target?: ValueOrGetter<SelectorTarget>
): ReactiveValue<VideoMedia[]> {
  return selectFromTarget<VideoMedia[]>(
    stream,
    target,
    EMPTY_VIDEO,
    (ns) => videoProjection(ns),
    "video"
  );
}

/**
 * Subscribe to a scoped file-media stream. Pair with `useMediaURL`
 * for an `<a download href>` target.
 */
export function useFiles(
  stream: AnyStream,
  target?: ValueOrGetter<SelectorTarget>
): ReactiveValue<FileMedia[]> {
  return selectFromTarget<FileMedia[]>(
    stream,
    target,
    EMPTY_FILES,
    (ns) => filesProjection(ns),
    "files"
  );
}

/**
 * Read metadata recorded for a specific message id — today exposes
 * `parentCheckpointId`, the checkpoint the message was first seen
 * on. Designed for fork / edit flows:
 *
 * ```svelte
 * <script lang="ts">
 *   const meta = useMessageMetadata(stream, () => selected?.id);
 * </script>
 * Parent: {meta.current?.parentCheckpointId ?? "root"}
 * ```
 *
 * `messageId` accepts a plain string or a getter — the binding
 * re-evaluates whenever the id changes.
 */
export function useMessageMetadata(
  stream: AnyStream,
  messageId: ValueOrGetter<string | undefined>
): ReactiveValue<MessageMetadata | undefined> {
  const store = stream[STREAM_CONTROLLER].messageMetadataStore;
  let map = $state<MessageMetadataMap>(store.getSnapshot());

  $effect(() => {
    const unsubscribe = store.subscribe(() => {
      map = store.getSnapshot();
    });
    return unsubscribe;
  });

  const getId = () =>
    isGetter(messageId) ? (messageId as () => string | undefined)() : messageId;

  return {
    get current(): MessageMetadata | undefined {
      const key = getId();
      if (key == null) return undefined;
      return map.get(key);
    },
  };
}

/**
 * Reactive handle on the server-side submission queue.
 *
 * Populated when `submit()` is invoked with
 * `multitaskStrategy: "enqueue"` while another run is in flight. The
 * returned getters are stable — safe to pass into `{#each}`.
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
  let entries = $state<SubmissionQueueSnapshot>(store.getSnapshot());

  $effect(() => {
    const unsubscribe = store.subscribe(() => {
      entries = store.getSnapshot();
    });
    return unsubscribe;
  });

  return {
    get entries() {
      return entries;
    },
    get size() {
      return entries.length;
    },
    cancel: (id) => controller.cancelQueued(id),
    clear: () => controller.clearQueue(),
  };
}

export type { SubmissionQueueEntry, SubmissionQueueSnapshot };

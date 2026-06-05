import { computed, effect, isSignal, type Signal } from "@angular/core";
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
import { injectProjection } from "./inject-projection.js";

/**
 * Selector primitives don't need to carry `InterruptType` /
 * `ConfigurableType`. Parameterising on `StateType` alone lets
 * callers with a full `injectStream<S, I, C>()` handle pass it in
 * without redeclaring those generics at every call site.
 */
type StreamHandle<StateType extends object> = UseStreamReturn<
  StateType,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  any
>;

/**
 * What a selector primitive can be targeted at. Callers can pass:
 *  - `undefined` / `null` — root namespace (served by the always-on
 *    root store — no extra subscription);
 *  - a {@link SubagentDiscoverySnapshot} (`stream.subagents().get(...)`);
 *  - a {@link SubgraphDiscoverySnapshot} (`stream.subgraphs().get(...)`);
 *  - an explicit `{ namespace: string[] }`;
 *  - a raw `string[]` escape hatch.
 *
 * Selectors also accept a `Signal<SelectorTarget>` so callers can
 * feed a `computed(() => ...)` and have the projection rebind
 * automatically.
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
 * Must be called from an injection context (as the selector primitives
 * are). A `Signal` target re-evaluates via an `effect`; a static target
 * resolves once. The controller de-dupes and skips already-promoted
 * ids.
 */
function resolveSubagentNamespaceFor(
  stream: AnyStream,
  target: SelectorTarget | Signal<SelectorTarget>
): void {
  const controller = stream[STREAM_CONTROLLER];
  if (isSignal(target)) {
    effect(() => {
      const id = subagentNeedingNamespace((target as Signal<SelectorTarget>)());
      if (id != null) void controller.resolveSubagentNamespace(id);
    });
    return;
  }
  const id = subagentNeedingNamespace(target as SelectorTarget);
  if (id != null) void controller.resolveSubagentNamespace(id);
}

function namespaceKey(namespace: readonly string[]): string {
  return namespace.join(NAMESPACE_SEPARATOR);
}

/**
 * Resolve a target or target-signal into a reactive
 * `[namespace, key]` pair. The helper returns plain signals so
 * `injectProjection` can track them via its internal effect.
 */
function normalizeTarget(
  target: SelectorTarget | Signal<SelectorTarget>,
  prefix: string
): {
  namespace: Signal<readonly string[]>;
  key: Signal<string>;
  isRootSignal: Signal<boolean>;
} {
  if (isSignal(target)) {
    const namespace = computed(() =>
      resolveNamespace((target as Signal<SelectorTarget>)())
    );
    const key = computed(() => `${prefix}|${namespaceKey(namespace())}`);
    const isRootSignal = computed(() => isRoot(namespace()));
    return { namespace, key, isRootSignal };
  }
  const ns = resolveNamespace(target as SelectorTarget);
  const staticKey = `${prefix}|${namespaceKey(ns)}`;
  return {
    namespace: computed(() => ns),
    key: computed(() => staticKey),
    isRootSignal: computed(() => isRoot(ns)),
  };
}

/**
 * Subscribe to a scoped `messages` stream.
 *
 * Contract:
 *  - At the root (no `target`) this returns `stream.messages` — the
 *    always-on root projection; no extra subscription is opened.
 *  - For any non-root namespace, call-time triggers a ref-counted
 *    `messages` subscription scoped to that namespace. The
 *    subscription is released automatically when the calling
 *    component / service is destroyed (and the registry closes the
 *    underlying server subscription when the last consumer leaves).
 *
 * Messages are always `BaseMessage` class instances from
 * `@langchain/core/messages`.
 */
export function injectMessages(
  stream: AnyStream,
  target?: SelectorTarget | Signal<SelectorTarget>
): Signal<BaseMessage[]> {
  resolveSubagentNamespaceFor(
    stream,
    target as SelectorTarget | Signal<SelectorTarget>
  );
  const { namespace, key, isRootSignal } = normalizeTarget(
    target as SelectorTarget | Signal<SelectorTarget>,
    "messages"
  );
  const registry = computed(() =>
    isRootSignal() ? null : getRegistry(stream)
  );
  const scoped = injectProjection<BaseMessage[]>(
    registry,
    () => messagesProjection(namespace()),
    key,
    EMPTY_MESSAGES
  );
  return computed(() => (isRootSignal() ? stream.messages() : scoped()));
}

const EMPTY_MESSAGES: BaseMessage[] = [];

/**
 * Subscribe to a scoped `tools` (tool-call) stream. Same target and
 * lifecycle rules as {@link injectMessages}; at the root this returns
 * `stream.toolCalls` directly.
 */
export function injectToolCalls(
  stream: AnyStream,
  target?: SelectorTarget | Signal<SelectorTarget>
): Signal<AssembledToolCall[]>;
export function injectToolCalls<T>(
  stream: AnyStream,
  target?: SelectorTarget | Signal<SelectorTarget>
): Signal<InferToolCalls<T>[]>;
export function injectToolCalls(
  stream: AnyStream,
  target?: SelectorTarget | Signal<SelectorTarget>
): Signal<AssembledToolCall[]> {
  resolveSubagentNamespaceFor(
    stream,
    target as SelectorTarget | Signal<SelectorTarget>
  );
  const { namespace, key, isRootSignal } = normalizeTarget(
    target as SelectorTarget | Signal<SelectorTarget>,
    "toolCalls"
  );
  const registry = computed(() =>
    isRootSignal() ? null : getRegistry(stream)
  );
  const scoped = injectProjection<AssembledToolCall[]>(
    registry,
    () => toolCallsProjection(namespace()),
    key,
    EMPTY_TOOLCALLS
  );
  return computed(() => (isRootSignal() ? stream.toolCalls() : scoped()));
}

const EMPTY_TOOLCALLS: AssembledToolCall[] = [];

/**
 * Subscribe to a scoped `values` stream — the most recent state
 * payload for a namespace. At the root returns `stream.values`.
 *
 * Typing:
 *  - **Root** (`injectValues(stream)`): returns the `StateType`
 *    declared on `injectStream<State>()` — non-nullable (the root
 *    snapshot always has values, falling back to `initialValues ??
 *    {}`).
 *  - **Scoped** (`injectValues(stream, target)`): scoped payloads can
 *    differ from the root state; callers should annotate the expected
 *    shape explicitly (`injectValues<SubagentState>(stream, sub)`).
 *    Defaults to `unknown` when not annotated.
 */
export function injectValues<StateType extends object>(
  stream: StreamHandle<StateType>
): Signal<StateType>;
export function injectValues<T>(stream: AnyStream): Signal<InferStateType<T>>;
export function injectValues<T = unknown>(
  stream: AnyStream,
  target: SelectorTarget | Signal<SelectorTarget>,
  options?: { messagesKey?: string }
): Signal<T | undefined>;
export function injectValues(
  stream: AnyStream,
  target?: SelectorTarget | Signal<SelectorTarget>,
  options?: { messagesKey?: string }
): Signal<unknown> {
  const messagesKey = options?.messagesKey ?? "messages";
  const { namespace, key, isRootSignal } = normalizeTarget(
    target as SelectorTarget | Signal<SelectorTarget>,
    `values|${messagesKey}`
  );
  const registry = computed(() =>
    isRootSignal() ? null : getRegistry(stream)
  );
  const scoped = injectProjection<unknown>(
    registry,
    () => valuesProjection<unknown>(namespace(), messagesKey),
    key,
    undefined
  );
  return computed(() => (isRootSignal() ? stream.values() : scoped()));
}

/**
 * Subscribe to a `custom:<name>` stream extension — the most recent
 * payload emitted by the transformer, scoped to the target namespace.
 */
export function injectExtension<T = unknown>(
  stream: AnyStream,
  name: string,
  target?: SelectorTarget | Signal<SelectorTarget>
): Signal<T | undefined> {
  const { namespace, key } = normalizeTarget(
    target as SelectorTarget | Signal<SelectorTarget>,
    `extension|${name}`
  );
  return injectProjection<T | undefined>(
    getRegistry(stream),
    () => extensionProjection<T>(name, namespace()),
    key,
    undefined
  );
}

/**
 * Raw-events escape hatch. Subscribes to one or more channels at a
 * namespace and returns a bounded buffer of raw protocol events.
 * Prefer {@link injectMessages} / {@link injectToolCalls} /
 * {@link injectValues} for the common cases.
 */
export type InjectChannelOptions = ChannelProjectionOptions;

export function injectChannel(
  stream: AnyStream,
  channels: readonly Channel[],
  target?: SelectorTarget | Signal<SelectorTarget>,
  options?: InjectChannelOptions
): Signal<Event[]> {
  const sortedChannels = [...channels].sort().join(",");
  const prefix = `channel|${options?.bufferSize ?? "default"}|${(options?.replay ?? true) ? "replay" : "live"}|${sortedChannels}`;
  const { namespace, key } = normalizeTarget(
    target as SelectorTarget | Signal<SelectorTarget>,
    prefix
  );
  return injectProjection<Event[]>(
    getRegistry(stream),
    () => channelProjection(channels, namespace(), options),
    key,
    EMPTY_EVENTS
  );
}

const EMPTY_EVENTS: Event[] = [];

/**
 * Subscribe to a scoped audio-media stream. Each handle is yielded
 * on its first matching `content-block-start`, exposes
 * `.partialBytes` for live access, settles `.blob` / `.objectURL` /
 * `.transcript` on `message-finish`, and surfaces errors via
 * `.error`.
 *
 * Pair with `injectMediaUrl` to turn a handle into an `<audio src>`.
 */
export function injectAudio(
  stream: AnyStream,
  target?: SelectorTarget | Signal<SelectorTarget>
): Signal<AudioMedia[]> {
  const { namespace, key } = normalizeTarget(
    target as SelectorTarget | Signal<SelectorTarget>,
    "audio"
  );
  return injectProjection<AudioMedia[]>(
    getRegistry(stream),
    () => audioProjection(namespace()),
    key,
    EMPTY_AUDIO
  );
}

const EMPTY_AUDIO: AudioMedia[] = [];

/**
 * Subscribe to a scoped image-media stream. Pair with
 * `injectMediaUrl` for `<img src>`.
 */
export function injectImages(
  stream: AnyStream,
  target?: SelectorTarget | Signal<SelectorTarget>
): Signal<ImageMedia[]> {
  const { namespace, key } = normalizeTarget(
    target as SelectorTarget | Signal<SelectorTarget>,
    "images"
  );
  return injectProjection<ImageMedia[]>(
    getRegistry(stream),
    () => imagesProjection(namespace()),
    key,
    EMPTY_IMAGES
  );
}

const EMPTY_IMAGES: ImageMedia[] = [];

/**
 * Subscribe to a scoped video-media stream. Pair with
 * `injectMediaUrl` for `<video src>`.
 */
export function injectVideo(
  stream: AnyStream,
  target?: SelectorTarget | Signal<SelectorTarget>
): Signal<VideoMedia[]> {
  const { namespace, key } = normalizeTarget(
    target as SelectorTarget | Signal<SelectorTarget>,
    "video"
  );
  return injectProjection<VideoMedia[]>(
    getRegistry(stream),
    () => videoProjection(namespace()),
    key,
    EMPTY_VIDEO
  );
}

const EMPTY_VIDEO: VideoMedia[] = [];

/**
 * Subscribe to a scoped file-media stream. Pair with
 * `injectMediaUrl` for an `<a download href>` target.
 */
export function injectFiles(
  stream: AnyStream,
  target?: SelectorTarget | Signal<SelectorTarget>
): Signal<FileMedia[]> {
  const { namespace, key } = normalizeTarget(
    target as SelectorTarget | Signal<SelectorTarget>,
    "files"
  );
  return injectProjection<FileMedia[]>(
    getRegistry(stream),
    () => filesProjection(namespace()),
    key,
    EMPTY_FILES
  );
}

const EMPTY_FILES: FileMedia[] = [];

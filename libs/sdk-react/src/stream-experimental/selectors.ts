/* __LC_ALLOW_ENTRYPOINT_SIDE_EFFECTS__ */

"use client";

import { useMemo } from "react";
import type { BaseMessage } from "@langchain/core/messages";
import {
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
  type Event,
  type FileMedia,
  type ImageMedia,
  type SubagentDiscoverySnapshot,
  type SubgraphDiscoverySnapshot,
  type VideoMedia,
} from "@langchain/langgraph-sdk/stream";
import {
  getRegistry,
  type UseStreamExperimentalReturn,
} from "./use-stream.js";
import { useProjection } from "./use-projection.js";

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
  return namespace.join("\u0000");
}

// The stream type we accept for selectors — purposely loose so
// selector hooks remain callable from components that don't carry
// the exact State/Interrupt/Configurable generics. We use `any` for
// all three generics because `UseStreamExperimentalReturn` is
// invariant in `State` and `Configurable` (they flow through both
// reader and writer positions), so a concrete
// `useStreamExperimental<typeof agent>()` handle wouldn't flow into
// a `<object, unknown, object>` slot otherwise.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyStream = UseStreamExperimentalReturn<any, any, any>;

/**
 * Subscribe to a scoped `messages` stream. Pass `stream` and
 * optionally a subagent/subgraph snapshot (or any namespaced target).
 *
 * Contract:
 *  - At the root (no target) this returns `stream.messages` directly
 *    — no extra subscription is opened.
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
 */
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
 */
export function useValues<T = unknown>(
  stream: AnyStream,
  target?: SelectorTarget,
  options?: { messagesKey?: string }
): T | undefined {
  const namespace = resolveNamespace(target);
  const messagesKey = options?.messagesKey ?? "messages";
  const key = `values|${messagesKey}|${namespaceKey(namespace)}`;
  const registry = isRoot(namespace) ? null : getRegistry(stream);
  const scoped = useProjection<T | undefined>(
    registry,
    () => valuesProjection<T>(namespace, messagesKey),
    key,
    undefined
  );
  return isRoot(namespace) ? (stream.values as unknown as T) : scoped;
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

export function useChannel(
  stream: AnyStream,
  channels: readonly Channel[],
  target?: SelectorTarget,
  options?: { bufferSize?: number }
): Event[] {
  const namespace = resolveNamespace(target);
  const channelKey = useMemo(() => [...channels].sort().join(","), [channels]);
  const key = `channel|${options?.bufferSize ?? "default"}|${channelKey}|${namespaceKey(namespace)}`;
  return useProjection<Event[]>(
    getRegistry(stream),
    () => channelProjection(channels, namespace, options),
    key,
    EMPTY_EVENTS
  );
}

const EMPTY_EVENTS: Event[] = [];

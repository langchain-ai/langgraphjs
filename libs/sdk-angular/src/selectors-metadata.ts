import {
  DestroyRef,
  computed,
  inject,
  isSignal,
  signal,
  type Signal,
} from "@angular/core";
import type {
  MessageMetadata,
  MessageMetadataMap,
} from "@langchain/langgraph-sdk/stream";
import { STREAM_CONTROLLER, type AnyStream } from "./use-stream.js";

/**
 * Read metadata recorded for a specific message id — today exposes
 * `parentCheckpointId`, the checkpoint the message was first seen on.
 * Designed for fork / edit flows:
 *
 * ```ts
 * readonly meta = injectMessageMetadata(this.stream, () => this.msg().id);
 * // meta()?.parentCheckpointId
 * ```
 *
 * `messageId` accepts a raw string, a `Signal<string | undefined>`,
 * or a plain getter — the binding re-evaluates whenever the id
 * changes.
 *
 * Returns `undefined` when the id isn't known yet (e.g. the server
 * hasn't emitted `parent_checkpoint` for that message, or the message
 * arrived via `messages`-channel deltas only and no `values` snapshot
 * has landed for it yet).
 */
export function injectMessageMetadata(
  stream: AnyStream,
  messageId:
    | string
    | undefined
    | Signal<string | undefined>
    | (() => string | undefined)
): Signal<MessageMetadata | undefined> {
  const destroyRef = inject(DestroyRef);
  const store = stream[STREAM_CONTROLLER].messageMetadataStore;

  const mapSignal = signal<MessageMetadataMap>(store.getSnapshot());
  const unsubscribe = store.subscribe(() => mapSignal.set(store.getSnapshot()));
  destroyRef.onDestroy(unsubscribe);

  const read: () => string | undefined = isSignal(messageId)
    ? (messageId as Signal<string | undefined>)
    : typeof messageId === "function"
      ? (messageId as () => string | undefined)
      : () => messageId as string | undefined;

  return computed(() => {
    const id = read();
    if (id == null) return undefined;
    return mapSignal().get(id);
  });
}

export type { MessageMetadata, MessageMetadataMap };

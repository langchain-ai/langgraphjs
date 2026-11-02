/**
 * Namespace-scoped media projections.
 *
 * Each factory opens `thread.subscribe({ channels: ["messages"],
 * namespaces: [ns] })`, runs the events through a {@link MediaAssembler},
 * filters to one media block type, and surfaces an array of handles
 * that grows as messages with that type are observed.
 *
 * Behaviour mirrors the iterables on `ThreadStream` / `SubgraphHandle` /
 * `SubagentHandle`:
 *  - One handle per `(messageId, blockType)`.
 *  - Yielded on the first matching `content-block-start` — messages
 *    with no matching blocks never appear.
 *  - Errors propagate through `handle.error` / rejected `blob` /
 *    rejected `objectURL`, not through the projection itself.
 *
 * `objectURL`s minted from these handles are caller-owned. The
 * companion `useMediaURL` React hook revokes on unmount; non-React
 * consumers should call `media.revoke()` when done.
 */
import type { Event, MessagesEvent } from "@langchain/protocol";
import { MediaAssembler } from "../../client/stream/media.js";
import type {
  AudioMedia,
  FileMedia,
  ImageMedia,
  VideoMedia,
} from "../../client/stream/media.js";
import type { ProjectionRuntime, ProjectionSpec } from "../types.js";
import { isRootNamespace, namespaceKey } from "../namespace.js";
import { openProjectionSubscription } from "./runtime.js";

interface MediaProjectionOptions {
  /**
   * Optional `fetch` for URL-sourced blocks. Forwarded into the
   * underlying {@link MediaAssembler}.
   */
  fetch?: typeof fetch;
}

function createMediaProjection<
  T extends AudioMedia | ImageMedia | VideoMedia | FileMedia,
>(
  kind: "audio" | "images" | "video" | "files",
  namespace: readonly string[],
  buildAssembler: (
    push: (m: T) => void,
    options?: MediaProjectionOptions
  ) => MediaAssembler,
  options?: MediaProjectionOptions
): ProjectionSpec<T[]> {
  const ns = [...namespace];
  const key = `${kind}|${namespaceKey(ns)}`;

  return {
    key,
    namespace: ns,
    initial: [],
    open({ thread, store, rootBus }): ProjectionRuntime {
      const assembler = buildAssembler((media) => {
        store.setValue([...store.getSnapshot(), media]);
      }, options);

      // The root pump is already subscribed to `messages` at root depth 1.
      // Root-scoped projections attach to it instead of opening a second
      // server subscription.
      const rootShortCircuit =
        isRootNamespace(ns) && rootBus.channels.includes("messages");

      if (rootShortCircuit) {
        const unsubscribe = rootBus.subscribe((event) => {
          if (event.method !== "messages") return;
          const matches = isRootNamespace(event.params.namespace);
          if (!matches) return;
          assembler.consume(event as MessagesEvent);
        });
        return {
          async dispose() {
            unsubscribe();
            for (const media of store.getSnapshot()) {
              try {
                media.revoke();
              } catch {
                // best-effort
              }
            }
            assembler.close();
          },
        };
      }

      const runtime = openProjectionSubscription({
        thread,
        channels: ["messages"],
        namespace: ns,
        onEvent(event: Event) {
          if (event.method !== "messages") return;
          assembler.consume(event as MessagesEvent);
        },
        onFinally() {
          assembler.close();
        },
      });

      return {
        async dispose() {
          // Revoke object URLs minted by handles owned by this
          // projection so unmount cleans up regardless of whether
          // individual hooks called `revoke()` themselves.
          for (const media of store.getSnapshot()) {
            try {
              media.revoke();
            } catch {
              // best-effort
            }
          }
          assembler.close();
          await runtime.dispose();
        },
      };
    },
  };
}

export function audioProjection(
  namespace: readonly string[],
  options?: MediaProjectionOptions
): ProjectionSpec<AudioMedia[]> {
  return createMediaProjection<AudioMedia>(
    "audio",
    namespace,
    (push, opts) =>
      new MediaAssembler({ fetch: opts?.fetch, onAudio: (m) => push(m) }),
    options
  );
}

export function imagesProjection(
  namespace: readonly string[],
  options?: MediaProjectionOptions
): ProjectionSpec<ImageMedia[]> {
  return createMediaProjection<ImageMedia>(
    "images",
    namespace,
    (push, opts) =>
      new MediaAssembler({ fetch: opts?.fetch, onImage: (m) => push(m) }),
    options
  );
}

export function videoProjection(
  namespace: readonly string[],
  options?: MediaProjectionOptions
): ProjectionSpec<VideoMedia[]> {
  return createMediaProjection<VideoMedia>(
    "video",
    namespace,
    (push, opts) =>
      new MediaAssembler({ fetch: opts?.fetch, onVideo: (m) => push(m) }),
    options
  );
}

export function filesProjection(
  namespace: readonly string[],
  options?: MediaProjectionOptions
): ProjectionSpec<FileMedia[]> {
  return createMediaProjection<FileMedia>(
    "files",
    namespace,
    (push, opts) =>
      new MediaAssembler({ fetch: opts?.fetch, onFile: (m) => push(m) }),
    options
  );
}

export type { MediaProjectionOptions };

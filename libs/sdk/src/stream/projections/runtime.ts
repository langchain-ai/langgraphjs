import type { Channel, Event } from "@langchain/protocol";
import type { SubscriptionHandle } from "../../client/stream/index.js";
import type { ProjectionRuntime, ThreadStream } from "../types.js";

interface ProjectionSubscriptionOptions {
  thread: ThreadStream;
  channels: readonly Channel[];
  namespace: readonly string[];
  depth?: number;
  /**
   * Some transports pause a subscription between runs. Most projections
   * intentionally preserve their historical one-pass behavior; opt in when
   * the projection already handled resume loops.
   */
  resumeOnPause?: boolean;
  onSubscribe?: () => void;
  onEvent(event: Event): void;
  onFinally?: () => void;
}

/**
 * Shared async subscription lifecycle for projection runtimes.
 */
export function openProjectionSubscription({
  thread,
  channels,
  namespace,
  depth = 1,
  resumeOnPause = false,
  onSubscribe,
  onEvent,
  onFinally,
}: ProjectionSubscriptionOptions): ProjectionRuntime {
  let handle: SubscriptionHandle<Event> | undefined;
  let disposed = false;

  const start = async () => {
    try {
      const subscription = await thread.subscribe({
        channels: [...channels],
        namespaces: namespace.length > 0 ? [[...namespace]] : [[]],
        depth,
      });
      handle = subscription;
      if (disposed) {
        await subscription.unsubscribe();
        return;
      }
      onSubscribe?.();

      do {
        for await (const event of subscription) {
          if (disposed) break;
          onEvent(event);
        }
        if (disposed || !resumeOnPause || !subscription.isPaused) break;
        await subscription.waitForResume();
      } while (!disposed);
    } catch {
      // Thread closed / errored; projections expose their last good snapshot.
    } finally {
      onFinally?.();
    }
  };

  void start();

  return {
    async dispose() {
      disposed = true;
      try {
        await handle?.unsubscribe();
      } catch {
        // already closed
      }
    },
  };
}

/**
 * Namespace-scoped `tools` projection.
 *
 * Opens `thread.subscribe({ channels: ["tools"], namespaces: [ns] })`,
 * feeds events through {@link ToolCallAssembler}, and surfaces an
 * array of {@link AssembledToolCall}s that grows as calls are
 * discovered. Each assembled call carries `output`/`status`/`error`
 * promises for consumers that want to await completion without
 * re-subscribing.
 */
import type { Event, ToolsEvent } from "@langchain/protocol";
import type { SubscriptionHandle } from "../../client/stream/index.js";
import { ToolCallAssembler } from "../../client/stream/handles/tools.js";
import type { AssembledToolCall } from "../../client/stream/handles/tools.js";
import { NAMESPACE_SEPARATOR } from "../constants.js";
import type { ProjectionSpec, ProjectionRuntime } from "../types.js";

export function toolCallsProjection(
  namespace: readonly string[]
): ProjectionSpec<AssembledToolCall[]> {
  const ns = [...namespace];
  const key = `toolCalls|${ns.join(NAMESPACE_SEPARATOR)}`;

  return {
    key,
    namespace: ns,
    initial: [],
    open({ thread, store, rootBus }): ProjectionRuntime {
      const assembler = new ToolCallAssembler();

      const applyToolsEvent = (event: ToolsEvent): void => {
        const tc = assembler.consume(event);
        if (tc == null) return;
        store.setValue([...store.getSnapshot(), tc]);
      };

      // See `messagesProjection` — root-scoped projections short-
      // circuit onto the root bus when the requested channels are
      // covered by the controller's root pump.
      const rootShortCircuit =
        ns.length === 0 && rootBus.channels.includes("tools");

      if (rootShortCircuit) {
        const unsubscribe = rootBus.subscribe((event) => {
          if (event.method !== "tools") return;
          if (event.params.namespace.length !== 0) return;
          applyToolsEvent(event as ToolsEvent);
        });
        return {
          dispose() {
            unsubscribe();
          },
        };
      }

      let handle: SubscriptionHandle<Event> | undefined;
      let disposed = false;

      const start = async () => {
        try {
          handle = await thread.subscribe({
            channels: ["tools"],
            namespaces: ns.length > 0 ? [ns] : [[]],
            depth: 1,
          });
          for await (const event of handle) {
            if (disposed) break;
            if (event.method !== "tools") continue;
            applyToolsEvent(event as ToolsEvent);
          }
        } catch {
          // closed / errored
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
    },
  };
}

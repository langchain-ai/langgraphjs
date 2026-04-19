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
import type { ProjectionSpec, ProjectionRuntime } from "../types.js";

export function toolCallsProjection(
  namespace: readonly string[]
): ProjectionSpec<AssembledToolCall[]> {
  const ns = [...namespace];
  const key = `toolCalls|${ns.join("\u0000")}`;

  return {
    key,
    namespace: ns,
    initial: [],
    open({ thread, store }): ProjectionRuntime {
      const assembler = new ToolCallAssembler();
      let handle: SubscriptionHandle<Event, unknown> | undefined;
      let disposed = false;

      const start = async () => {
        try {
          handle = await thread.subscribe({
            channels: ["tools"],
            namespaces: ns.length > 0 ? [ns] : undefined,
          });
          for await (const event of handle) {
            if (disposed) break;
            if (event.method !== "tools") continue;
            const tc = assembler.consume(event as ToolsEvent);
            if (tc == null) continue;
            store.setValue([...store.getSnapshot(), tc]);
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

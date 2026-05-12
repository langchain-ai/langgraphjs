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
import type { ToolsEvent } from "@langchain/protocol";
import { ToolCallAssembler } from "../../client/stream/handles/tools.js";
import type { AssembledToolCall } from "../../client/stream/handles/tools.js";
import type { ProjectionSpec, ProjectionRuntime } from "../types.js";
import { isRootNamespace, namespaceKey } from "../namespace.js";
import { upsertToolCall } from "../tool-calls.js";
import { openProjectionSubscription } from "./runtime.js";

export function toolCallsProjection(
  namespace: readonly string[]
): ProjectionSpec<AssembledToolCall[]> {
  const ns = [...namespace];
  const key = `toolCalls|${namespaceKey(ns)}`;

  return {
    key,
    namespace: ns,
    initial: [],
    open({ thread, store, rootBus }): ProjectionRuntime {
      const assembler = new ToolCallAssembler();

      const applyToolsEvent = (event: ToolsEvent): void => {
        const data = event.params.data;
        if (
          ns.length > 0 &&
          event.params.namespace.length === ns.length &&
          data.tool_name === "task"
        ) {
          return;
        }
        const tc = assembler.consume(event);
        if (tc == null) return;
        const next = upsertToolCall(store.getSnapshot(), tc);
        store.setValue(next);
      };

      // See `messagesProjection` — root-scoped projections short-
      // circuit onto the root bus when the requested channels are
      // covered by the controller's root pump.
      const rootShortCircuit =
        isRootNamespace(ns) && rootBus.channels.includes("tools");

      if (rootShortCircuit) {
        const unsubscribe = rootBus.subscribe((event) => {
          if (event.method !== "tools") return;
          if (!isRootNamespace(event.params.namespace)) return;
          applyToolsEvent(event as ToolsEvent);
        });
        return {
          dispose() {
            unsubscribe();
          },
        };
      }

      const runtime = openProjectionSubscription({
        thread,
        channels: ["tools"],
        namespace: ns,
        onEvent(event) {
          if (event.method !== "tools") return;
          applyToolsEvent(event as ToolsEvent);
        },
      });

      return {
        async dispose() {
          await runtime.dispose();
        },
      };
    },
  };
}

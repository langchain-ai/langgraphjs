import { useMemo } from "react";
import { useChannel, useStreamContext } from "@langchain/react";
import type { StoryState } from "./types";

export interface NodeRun {
  /** Stream namespace for this node run, used to scope media hooks. */
  namespace: readonly string[];
  /** Latest lifecycle status inferred from emitted lifecycle events. */
  status: "running" | "complete" | "error";
}

/**
 * Tracks the latest observed run for a graph node by reading lifecycle events
 * from the current stream.
 *
 * The returned `namespace` can be passed to media hooks such as `useImages` or
 * `useAudio` so they subscribe to the artifacts emitted by that specific node
 * run. The hook returns `undefined` until the node emits its first lifecycle
 * event with a namespace.
 */
export function useNodeRun(nodeName: string): NodeRun | undefined {
  const stream = useStreamContext<StoryState>();
  const events = useChannel(stream, ["lifecycle", "messages"]);

  return useMemo(() => {
    let latest: NodeRun | undefined;
    for (const event of events) {
      if (event.params.namespace.length === 0) continue;

      const namespace = [...event.params.namespace];
      const data = event.params.data as {
        event?: string;
        graph_name?: string;
      };

      const segment = namespace[namespace.length - 1];
      const observedNodeName =
        event.method === "lifecycle"
          ? data.graph_name
          : segment?.split(":", 1)[0];
      if (observedNodeName !== nodeName) {
        continue;
      }

      // LangGraph emits several lifecycle event names. For this demo the UI
      // only needs three coarse states: active, done, or failed.
      const status =
        event.method === "messages" && data.event === "message-finish"
          ? "complete"
          : data.event === "failed"
            ? "error"
            : data.event === "completed" || data.event === "interrupted"
              ? "complete"
              : "running";
      latest = { namespace, status };
    }
    return latest;
  }, [events, nodeName]);
}

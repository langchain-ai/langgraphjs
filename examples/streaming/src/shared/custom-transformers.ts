/**
 * Shared custom `StreamTransformer` factories used by the
 * `custom-transformer/` examples.
 *
 * Two patterns are demonstrated:
 *
 *   1. Final values — promises resolved once when the run ends (e.g. total
 *      token count).  Consumers `await` them after the stream is done.
 *
 *   2. Streaming updates — a `StreamChannel` that yields incremental items as
 *      events arrive.  Consumers iterate them concurrently with the main
 *      event stream.  Use `StreamChannel.remote(name)` when those items should
 *      also be visible to remote clients as `custom:<name>`.
 */

import type {
  MessagesEventData,
  ProtocolEvent,
  StreamTransformer,
  ToolsEventData,
} from "@langchain/langgraph";
import { StreamChannel } from "@langchain/langgraph";

/**
 * Pattern 1: Final values — resolved once at the end of the run.
 */
export const statsTransformer = (): StreamTransformer<{
  toolCallCount: Promise<number>;
  totalTokens: Promise<number>;
}> => {
  let tools = 0;
  let tokens = 0;

  let resolveTools: (n: number) => void;
  let resolveTokens: (n: number) => void;
  const toolCallCount = new Promise<number>((r) => {
    resolveTools = r;
  });
  const totalTokens = new Promise<number>((r) => {
    resolveTokens = r;
  });

  return {
    init: () => ({ toolCallCount, totalTokens }),

    process(event: ProtocolEvent): boolean {
      if (event.method === "tools") {
        const data = event.params.data as ToolsEventData;
        if (data.event === "tool-started") tools += 1;
      }

      if (event.method === "messages") {
        const data = event.params.data as MessagesEventData;
        if (data.event === "message-finish" && data.usage) {
          tokens +=
            (data.usage.input_tokens ?? 0) + (data.usage.output_tokens ?? 0);
        }
      }

      return true;
    },

    finalize() {
      resolveTools(tools);
      resolveTokens(tokens);
    },

    fail() {
      resolveTools(tools);
      resolveTokens(tokens);
    },
  };
};

/**
 * Pattern 2: Streaming updates — yields tool activity as it happens.
 *
 * `StreamChannel.remote()` acts as both the async buffer for in-process
 * consumers and the auto-forwarding mechanism for remote SDK clients.  Use
 * `StreamChannel.local()` for in-process-only projections.  The mux
 * auto-closes the channel when the run ends — no manual finalize/fail needed.
 */
export const toolActivityTransformer = (): StreamTransformer<{
  toolActivity: StreamChannel<{ name: string; status: string }>;
}> => {
  const toolActivity = StreamChannel.remote<{ name: string; status: string }>(
    "toolActivity"
  );

  // maps tool_call_id to tool_name
  const tools = new Map<string, string>();
  return {
    init: () => ({ toolActivity }),

    process(event: ProtocolEvent): boolean {
      if (event.method !== "tools") return true;

      const data = event.params.data as ToolsEventData;
      if (data.event === "tool-started") {
        toolActivity.push({ name: data.tool_name, status: "started" });
        tools.set(data.tool_call_id, data.tool_name);
      } else if (data.event === "tool-finished") {
        toolActivity.push({ name: tools.get(data.tool_call_id) ?? data.tool_call_id, status: "finished" });
      } else if (data.event === "tool-error") {
        toolActivity.push({ name: tools.get(data.tool_call_id) ?? data.tool_call_id, status: "error" });
      }
      return true;
    },
  };
};

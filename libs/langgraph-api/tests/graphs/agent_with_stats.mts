/**
 * Test graph used to verify that final-value stream transformers surface
 * remotely via `thread.extensions.<name>`.
 *
 * The compiled graph registers `statsTransformer`, whose projection is
 * `{ toolCallCount: Promise<number>, totalTokens: Promise<number> }`
 * (final values resolved in `finalize()`). The graph itself just simulates
 * one tool invocation so there is at least one `tool-started` event for
 * the transformer to count.
 */
import {
  END,
  MessagesAnnotation,
  START,
  StateGraph,
  type StreamTransformer,
} from "@langchain/langgraph";
import type {
  MessagesEventData,
  ProtocolEvent,
  ToolsEventData,
} from "@langchain/langgraph";
import { AIMessage, ToolMessage } from "@langchain/core/messages";

const statsTransformer = (): StreamTransformer<{
  toolCallCount: Promise<number>;
  totalTokens: Promise<number>;
}> => {
  let tools = 0;
  let tokens = 0;

  let resolveTools!: (n: number) => void;
  let resolveTokens!: (n: number) => void;
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

const aiWithToolCall = new AIMessage({
  content: "",
  tool_calls: [
    {
      id: "call_stats_1",
      args: { query: "SF" },
      name: "weather",
      type: "tool_call",
    },
  ],
});

const aiDone = new AIMessage({ content: "Done." });

async function agentNode(state: typeof MessagesAnnotation.State) {
  const last = state.messages[state.messages.length - 1];
  if (
    last &&
    typeof (last as ToolMessage).tool_call_id === "string" &&
    (last as ToolMessage).tool_call_id === "call_stats_1"
  ) {
    return { messages: [aiDone] };
  }
  return { messages: [aiWithToolCall] };
}

async function toolNode(state: typeof MessagesAnnotation.State) {
  const lastAi = state.messages[state.messages.length - 1] as AIMessage;
  const call = lastAi.tool_calls?.[0];
  if (!call) return { messages: [] };
  return {
    messages: [
      new ToolMessage({
        content: "It's 60 degrees and foggy.",
        tool_call_id: call.id ?? "tool_call_id",
        name: call.name,
      }),
    ],
  };
}

function shouldContinue(
  state: typeof MessagesAnnotation.State
): "tools" | typeof END {
  const lastMessage = state.messages[state.messages.length - 1];
  if (!(lastMessage instanceof AIMessage)) return END;
  return (lastMessage.tool_calls?.length ?? 0) > 0 ? "tools" : END;
}

const workflow = new StateGraph(MessagesAnnotation)
  .addNode("agent", agentNode)
  .addNode("tools", toolNode)
  .addEdge(START, "agent")
  .addConditionalEdges("agent", shouldContinue)
  .addEdge("tools", "agent");

export const graph = workflow.compile({
  transformers: [statsTransformer],
});

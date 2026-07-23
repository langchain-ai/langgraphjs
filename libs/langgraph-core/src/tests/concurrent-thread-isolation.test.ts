import { describe, it, expect } from "vitest";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { tool, type ToolRuntime } from "@langchain/core/tools";
import { AIMessage, BaseMessage, HumanMessage } from "@langchain/core/messages";
import { Annotation, StateGraph } from "../graph/index.js";
import { END, START } from "../constants.js";
import { ToolNode } from "../prebuilt/tool_node.js";
import {
  ensureLangGraphConfig,
  getCurrentTaskInput,
} from "../pregel/utils/config.js";
import { initializeAsyncLocalStorageSingleton } from "../node.js";

initializeAsyncLocalStorageSingleton();

const delay = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const AgentState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (left, right) => left.concat(right),
    default: () => [],
  }),
  customer: Annotation<string>({
    reducer: (_, right) => right,
    default: () => "",
  }),
});

/**
 * Singleton compiled graphs shared across concurrent `invoke()` calls with
 * different `thread_id` values must not leak state, metadata, or task input
 * between threads.
 */
describe("concurrent thread isolation", () => {
  it("ensureLangGraphConfig does not mutate shared graph-bound config", async () => {
    const sharedBound = {
      metadata: { graph_id: "agent" },
      configurable: { ls_agent_type: "chatbot" },
      tags: ["bound"],
    };

    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        Promise.resolve().then(() =>
          ensureLangGraphConfig(sharedBound, {
            configurable: { thread_id: `thread-${i}` },
          })
        )
      )
    );

    expect(sharedBound.metadata).toEqual({ graph_id: "agent" });
    expect(sharedBound.configurable).toEqual({ ls_agent_type: "chatbot" });
    expect(sharedBound.tags).toEqual(["bound"]);
  });

  it("concurrent invokes keep checkpoint state isolated on a singleton graph", async () => {
    const checkpointer = new MemorySaver();
    const sharedBound = {
      metadata: { graph_id: "agent" },
      configurable: { ls_agent_type: "chatbot" },
    };

    const recordCustomer = tool(
      async (
        input: { name: string },
        runtime: ToolRuntime<typeof AgentState.State>
      ) => {
        return `recorded:${input.name}:thread=${runtime.config.configurable?.thread_id}`;
      },
      {
        name: "record_customer",
        description: "Record customer name.",
        schema: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
      }
    );

    const callTools = new ToolNode([recordCustomer]);

    const callModel = async () => {
      await delay(50);
      const threadId = getCurrentTaskInput<{ customer: string }>().customer;
      return {
        messages: [
          new AIMessage({
            content: "",
            tool_calls: [
              {
                name: "record_customer",
                args: { name: threadId },
                id: `call-${threadId}`,
              },
            ],
          }),
        ],
      };
    };

    // Singleton graph — mirrors production `createAgent()` pattern.
    const graph = new StateGraph(AgentState)
      .addNode("agent", callModel)
      .addNode("tools", callTools)
      .addEdge(START, "agent")
      .addEdge("agent", "tools")
      .addEdge("tools", END)
      .compile({ checkpointer })
      .withConfig(sharedBound);

    const threads = ["customer-a", "customer-b", "customer-c", "customer-d"];

    const results = await Promise.all(
      threads.map((customer) =>
        graph.invoke(
          {
            messages: [new HumanMessage(`Order for ${customer}`)],
            customer,
          },
          { configurable: { thread_id: customer } }
        )
      )
    );

    for (let i = 0; i < threads.length; i += 1) {
      const customer = threads[i];
      const result = results[i];
      const toolMessage = result.messages.find(
        (m) => m.getType() === "tool"
      );
      expect(toolMessage?.content).toBe(`recorded:${customer}:thread=${customer}`);

      const checkpoint = await checkpointer.getTuple({
        configurable: { thread_id: customer },
      });
      const savedCustomer = (
        checkpoint?.checkpoint.channel_values as { customer?: string }
      )?.customer;
      expect(savedCustomer).toBe(customer);
    }

    // Bound config must remain untouched after concurrent invocations.
    expect(sharedBound.metadata).toEqual({ graph_id: "agent" });
    expect(sharedBound.configurable).toEqual({ ls_agent_type: "chatbot" });
  });
});

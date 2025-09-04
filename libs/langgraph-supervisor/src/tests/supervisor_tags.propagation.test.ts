import { describe, it, expect } from "vitest";
import { AIMessage } from "@langchain/core/messages";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { Serialized } from "@langchain/core/load/serializable";
import { ChainValues } from "@langchain/core/utils/types";
import { createSupervisor } from "../supervisor.js";
import { FakeToolCallingChatModel } from "./utils.js";

describe("supervisor preserves child agent bound tags", () => {
  it("agent.withConfig({ tags }) appears on agent span when invoked by supervisor", async () => {
    const TAG = "child_agent_tag";

    const seen: {
      runType: string;
      runName?: string;
      tags?: string[];
      metadata?: Record<string, unknown>;
    }[] = [];

    // Spy handler to capture tags at run starts
    class SpyHandler extends BaseCallbackHandler {
      name = "SpyHandler";

      // Manager invokes "handle*" methods on handlers. Capture tags from the appropriate position.
      async handleChainStart(
        _chain: Serialized,
        _inputs: ChainValues,
        _runId?: string,
        _runType?: string,
        tags?: string[],
        metadata?: Record<string, unknown>,
        runName?: string
      ) {
        seen.push({ runType: "chain", runName, tags, metadata });
      }

      async handleToolStart(
        _tool: Serialized,
        _input: string,
        _runId?: string,
        _parentRunId?: string,
        tags?: string[],
        metadata?: Record<string, unknown>,
        runName?: string
      ) {
        seen.push({ runType: "tool", runName, tags, metadata });
      }

      async handleLLMStart(
        _llm: Serialized,
        _prompts: string[],
        _runId?: string,
        _parentRunId?: string,
        _extraParams?: Record<string, unknown>,
        tags?: string[],
        metadata?: Record<string, unknown>,
        runName?: string
      ) {
        seen.push({ runType: "llm", runName, tags, metadata });
      }
    }
    const spy = new SpyHandler();

    // Supervisor model: tool-calls into our agent, then final answer
    const supervisorModel = new FakeToolCallingChatModel({
      responses: [
        new AIMessage({
          content: "",
          tool_calls: [
            {
              name: "transfer_to_childagent",
              args: {},
              id: "call_handoff",
              type: "tool_call",
            },
          ],
        }),
        new AIMessage({ content: "done" }),
      ],
    });

    // Child agent model: produce a single final message
    const agentModel = new FakeToolCallingChatModel({
      responses: [new AIMessage({ content: "classified" })],
    });

    const worker = createReactAgent({
      llm: agentModel,
      tools: [],
      name: "childAgent",
      prompt: "you are terse",
    }).withConfig({ tags: [TAG], runName: "agent:child_agent" });

    const sup = createSupervisor({ agents: [worker], llm: supervisorModel });

    const app = sup.compile();
    await app.invoke(
      { messages: [{ role: "user", content: "hi" }] },
      { callbacks: [spy] }
    );

    const agentChain = seen.find(
      (e) =>
        e.runType === "chain" &&
        Array.isArray(e.tags) &&
        e.tags.includes(TAG) &&
        (e.metadata as { langgraph_node?: string } | undefined)
          ?.langgraph_node === "childAgent"
    );
    expect(agentChain).toBeTruthy();
    expect(agentChain?.tags).toEqual(expect.arrayContaining([TAG]));
  });
});

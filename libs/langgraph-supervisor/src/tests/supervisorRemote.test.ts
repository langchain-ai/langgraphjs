import { describe, it, expect } from "vitest";
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import { v5 as uuidv5 } from "uuid";
import { RemoteGraph } from "@langchain/langgraph/remote";
import { createReactAgent, ToolNode } from "@langchain/langgraph/prebuilt";
import { createSupervisor } from "../supervisor.js";
import { FakeToolCallingChatModel } from "./utils.js";

class FakeRemoteGraph extends RemoteGraph {
  public receivedThreadIds: Array<string | undefined> = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override async invoke(_state: any, config?: any) {
    this.receivedThreadIds.push(config?.configurable?.thread_id);
    return { messages: [new AIMessage({ content: "remote result" })] };
  }
}

describe("Supervisor with RemoteGraph agents", () => {
  it("propagates per-agent thread_id and exposes handoff tool description", async () => {
    const ROOT_THREAD_ID = "123e4567-e89b-12d3-a456-426614174000";

    // Supervisor will transfer to the remote agent, then produce a final answer
    const supervisorMessages = [
      new AIMessage({
        content: "",
        tool_calls: [
          {
            name: "transfer_to_remote_expert",
            args: {},
            id: "call_remote_handoff",
            type: "tool_call",
          },
        ],
      }),
      new AIMessage({ content: "done" }),
    ];

    const supervisorModel = new FakeToolCallingChatModel({
      responses: supervisorMessages,
    });

    // Prepare RemoteGraph agent
    const remote = new FakeRemoteGraph({ graphId: "dummy" });
    (remote as unknown as { name?: string }).name = "remote_expert";
    (remote as unknown as { description?: string }).description = "Remote expert doing remote things.";

    // Build supervisor workflow
    const workflow = createSupervisor({
      agents: [remote],
      llm: supervisorModel,
      prompt: "You are a supervisor managing a remote expert.",
    });

    // Assert handoff tool includes remote description
    const toolNode = (
      workflow.nodes.supervisor.runnable as ReturnType<typeof createReactAgent>
    ).nodes.tools.bound as ToolNode;

    expect(toolNode.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "transfer_to_remote_expert",
          description: "Remote expert doing remote things.",
        }),
      ])
    );

    // Compile and invoke with a root thread id
    const app = workflow.compile();
    const result = await app.invoke(
      { messages: [new HumanMessage({ content: "hi" })] },
      { configurable: { thread_id: ROOT_THREAD_ID } }
    );

    expect(result).toBeDefined();

    // Verify per-agent thread id derivation is passed to the RemoteGraph
    const expectedAgentThreadId = uuidv5("remote_expert", ROOT_THREAD_ID);
    expect(remote.receivedThreadIds[0]).toBe(expectedAgentThreadId);
  });
});

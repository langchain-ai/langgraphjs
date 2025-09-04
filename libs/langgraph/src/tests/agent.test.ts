import { describe, expect, it } from "vitest";
import { createAgent, AgentMiddleware } from "../agent/agent";
import { FakeToolCallingChatModel } from "./utils.models";
import { tool } from "@langchain/core/tools";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import {
  _AnyIdAIMessage,
  _AnyIdHumanMessage,
  _AnyIdToolMessage,
} from "./utils";

describe("createAgent", () => {
  it("basic test", async () => {
    const newTool = tool(() => ({ hello: "world" }), {
      name: "newTool",
      description: "A new tool",
    });

    const agent = createAgent({
      model: new FakeToolCallingChatModel({
        responses: [
          new AIMessage({
            content: "result1",
            tool_calls: [
              { name: "newTool", id: "tool_abcd123", args: { query: "foo" } },
            ],
          }),
        ],
      }),
      tools: [newTool],
    }).compile();

    const result = await agent.invoke({
      messages: [new HumanMessage("Hello Input!")],
    });

    expect(result.messages).toEqual([
      new _AnyIdHumanMessage("Hello Input!"),
      new _AnyIdAIMessage({
        content: "result1",
        tool_calls: [
          { name: "newTool", id: "tool_abcd123", args: { query: "foo" } },
        ],
      }),
      new _AnyIdToolMessage({
        name: "newTool",
        content: JSON.stringify({ hello: "world" }, null, 2),
        tool_call_id: "tool_abcd123",
      }),
    ]);
  });

  it("middleware", async () => {
    const calls: string[] = [];
    const oneMiddleware: AgentMiddleware = {
      name: "oneMiddleware",
      beforeModel: () => {
        calls.push("oneMiddleware.beforeModel");
        return {};
      },
      afterModel: () => {
        calls.push("oneMiddleware.afterModel");
        return {};
      },
      modifyModelRequest: (request) => {
        calls.push("oneMiddleware.modifyModelRequest");
        return request;
      },
    };

    const twoMiddleware: AgentMiddleware = {
      name: "twoMiddleware",
      beforeModel: () => {
        calls.push("twoMiddleware.beforeModel");
        return {};
      },
      afterModel: () => {
        calls.push("twoMiddleware.afterModel");
        return {};
      },
      modifyModelRequest: (request) => {
        calls.push("twoMiddleware.modifyModelRequest");
        return request;
      },
    };

    const agent = createAgent({
      model: new FakeToolCallingChatModel({
        responses: [new AIMessage({ content: "result1" })],
      }),
      middleware: [oneMiddleware, twoMiddleware],
      tools: [],
    }).compile();

    await agent.invoke({
      messages: [new HumanMessage("Hello Input!")],
    });

    expect(calls).toEqual([
      "oneMiddleware.beforeModel",
      "twoMiddleware.beforeModel",
      "oneMiddleware.modifyModelRequest",
      "twoMiddleware.modifyModelRequest",
      "twoMiddleware.afterModel",
      "oneMiddleware.afterModel",
    ]);
  });
});

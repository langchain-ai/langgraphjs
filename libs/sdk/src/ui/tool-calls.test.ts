import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import type { AssembledToolCall } from "./tool-payload.js";
import {
  reconcileToolCallsFromMessages,
  seedToolCallsFromMessages,
  upsertToolCall,
} from "./tool-calls.js";

describe("seedToolCallsFromMessages", () => {
  it("fails a call whose tool message has status error, with its text as the error", () => {
    const toolCalls = seedToolCallsFromMessages(
      [],
      [
        new AIMessage({
          content: "",
          tool_calls: [{ id: "call-1", name: "search", args: {} }],
        }),
        new ToolMessage({
          content: "Error: boom",
          tool_call_id: "call-1",
          status: "error",
        }),
      ]
    );

    expect(toolCalls).toMatchObject([
      { callId: "call-1", status: "error", error: "Error: boom", output: null },
    ]);
  });

  const oneOfTwoAnswered = [
    new AIMessage({
      content: "",
      tool_calls: [
        { id: "call-1", name: "search", args: {} },
        { id: "call-2", name: "search", args: {} },
      ],
    }),
    new ToolMessage({ content: "found", tool_call_id: "call-1" }),
  ];

  it("marks a call with no result incomplete when no run streams", () => {
    expect(
      seedToolCallsFromMessages([], oneOfTwoAnswered, { isLoading: false })
    ).toMatchObject([
      { callId: "call-1", status: "finished", output: "found" },
      { callId: "call-2", status: "incomplete", output: null },
    ]);
  });

  it("marks a call incomplete once a later message closed its turn, even while a run streams", () => {
    const later = [...oneOfTwoAnswered, new HumanMessage("try again")];
    expect(
      seedToolCallsFromMessages([], later, { isLoading: true })
    ).toMatchObject([
      { callId: "call-1", status: "finished" },
      { callId: "call-2", status: "incomplete" },
    ]);
  });

  it("keeps a call with no result running while a run streams, or when isLoading is left out", () => {
    for (const options of [{ isLoading: true }, undefined]) {
      expect(
        seedToolCallsFromMessages([], oneOfTwoAnswered, options)
      ).toMatchObject([
        { callId: "call-1", status: "finished" },
        { callId: "call-2", status: "running" },
      ]);
    }
  });
});

describe("reconcileToolCallsFromMessages", () => {
  const runningCall: AssembledToolCall = {
    name: "memory_put",
    callId: "toolu_018cV6Rpn1Fc3PStvtyoB8cv",
    id: "toolu_018cV6Rpn1Fc3PStvtyoB8cv",
    namespace: ["tools:a206a533-1cb5-5d3d-8ab1-c044ea65754d"],
    input: { key: "user_name", value: "Alex" },
    args: { key: "user_name", value: "Alex" },
    output: null,
    status: "error",
    error: "interrupt pending",
  };

  it("finishes an existing errored tool call from a ToolMessage result", () => {
    const result = reconcileToolCallsFromMessages(
      [runningCall],
      [
        new ToolMessage({
          content: JSON.stringify({
            toolu_018cV6Rpn1Fc3PStvtyoB8cv: {
              success: true,
              action: "updated",
              key: "user_name",
              message: 'Memory "user_name" updated',
            },
          }),
          tool_call_id: "toolu_018cV6Rpn1Fc3PStvtyoB8cv",
        }),
      ]
    );

    expect(result[0]).toMatchObject({
      status: "finished",
      error: undefined,
      output: {
        toolu_018cV6Rpn1Fc3PStvtyoB8cv: {
          message: 'Memory "user_name" updated',
        },
      },
    });
  });

  it("keeps the error of a call that already failed", () => {
    const current = [runningCall];
    const result = reconcileToolCallsFromMessages(current, [
      new ToolMessage({
        content: "Error: boom",
        tool_call_id: "toolu_018cV6Rpn1Fc3PStvtyoB8cv",
        status: "error",
      }),
    ]);

    expect(result).toBe(current);
  });

  it("does not overwrite a finished tool call", () => {
    const finished: AssembledToolCall = {
      ...runningCall,
      output: { original: true },
      status: "finished",
      error: undefined,
    };

    const current = [finished];
    const result = reconcileToolCallsFromMessages(
      current,
      [
        new ToolMessage({
          content: '{"changed":true}',
          tool_call_id: "toolu_018cV6Rpn1Fc3PStvtyoB8cv",
        }),
      ]
    );

    expect(result).toBe(current);
  });
});

describe("upsertToolCall", () => {
  it("replaces existing tool calls with a fresh object snapshot", () => {
    const current: AssembledToolCall = {
      name: "memory_put",
      callId: "toolu_01",
      id: "toolu_01",
      namespace: ["tools:one"],
      input: { key: "user_role" },
      args: { key: "user_role" },
      output: null,
      status: "running",
      error: undefined,
    };
    const next: AssembledToolCall = {
      ...current,
      output: { success: true },
      status: "finished",
    };

    const result = upsertToolCall([current], next);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(next);
    expect(result[0]).not.toBe(next);
    expect(result[0]).not.toBe(current);
  });
});

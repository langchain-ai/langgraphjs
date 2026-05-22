import { ToolMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import type { AssembledToolCall } from "../client/stream/handles/tools.js";
import { reconcileToolCallsFromMessages } from "./tool-calls.js";

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

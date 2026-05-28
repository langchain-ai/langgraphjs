import { describe, expect, it } from "vitest";

import {
  ToolCallAssembler,
  parseToolOutput,
  shouldIgnoreScopedTaskToolEvent,
} from "./tools.js";
import { eventOf } from "../test/utils.js";

describe("shouldIgnoreScopedTaskToolEvent", () => {
  it("ignores scoped task tool-started events", () => {
    const event = eventOf(
      "tools",
      {
        event: "tool-started",
        tool_call_id: "task_1",
        tool_name: "task",
        input: { description: "Work", subagent_type: "worker" },
      },
      { namespace: ["tools:worker"], seq: 1 }
    );

    expect(
      shouldIgnoreScopedTaskToolEvent(["tools:worker"], event as never)
    ).toBe(true);
  });

  it("does not ignore real tools in a scoped namespace", () => {
    const event = eventOf(
      "tools",
      {
        event: "tool-started",
        tool_call_id: "search-1",
        tool_name: "search_web",
        input: { query: "test" },
      },
      { namespace: ["tools:worker"], seq: 1 }
    );

    expect(
      shouldIgnoreScopedTaskToolEvent(["tools:worker"], event as never)
    ).toBe(false);
  });

  it("does not ignore task events from a different namespace", () => {
    const event = eventOf(
      "tools",
      {
        event: "tool-started",
        tool_call_id: "task_1",
        tool_name: "task",
        input: { description: "Work", subagent_type: "worker" },
      },
      { namespace: ["tools:other-worker"], seq: 1 }
    );

    expect(
      shouldIgnoreScopedTaskToolEvent(["tools:worker"], event as never)
    ).toBe(false);
  });

  it("does not ignore root-level task dispatch events", () => {
    const event = eventOf(
      "tools",
      {
        event: "tool-started",
        tool_call_id: "task_1",
        tool_name: "task",
        input: { description: "Work", subagent_type: "worker" },
      },
      { namespace: [], seq: 1 }
    );

    expect(shouldIgnoreScopedTaskToolEvent([], event as never)).toBe(false);
  });
});

describe("parseToolOutput", () => {
  it("unwraps Command outputs with a matching ToolMessage", () => {
    expect(
      parseToolOutput(
        {
          lg_name: "Command",
          update: {
            messages: [
              {
                type: "tool",
                tool_call_id: "query-1",
                name: "query_database",
                content: JSON.stringify({
                  status: "success",
                  table: "users",
                  count: 2,
                }),
              },
            ],
          },
        },
        "query-1"
      )
    ).toEqual({
      status: "success",
      table: "users",
      count: 2,
    });
  });

  it("unwraps Command outputs serialized as JSON strings", () => {
    expect(
      parseToolOutput(
        JSON.stringify({
          lg_name: "Command",
          update: {
            messages: [
              {
                type: "tool",
                tool_call_id: "search-1",
                content: "Weather in SF: sunny",
              },
            ],
          },
        }),
        "search-1"
      )
    ).toBe("Weather in SF: sunny");
  });

  it("preserves Command outputs without ToolMessages", () => {
    const command = {
        lg_name: "Command",
        update: {
          files: {},
          messages: [
            {
              type: "ai",
              content: [{ type: "text", text: "Done" }],
            },
          ],
        },
      };

    expect(parseToolOutput(command)).toBe(command);
  });

  it("preserves Command outputs when no ToolMessage matches the call id", () => {
    const command = {
      lg_name: "Command",
      update: {
        messages: [
          {
            type: "tool",
            tool_call_id: "other-call",
            content: JSON.stringify({ count: 2 }),
          },
        ],
      },
    };

    expect(parseToolOutput(command, "query-1")).toBe(command);
  });
});

describe("ToolCallAssembler Command outputs", () => {
  it("resolves parsed tool values from Command tool-finished payloads", async () => {
    const assembler = new ToolCallAssembler();
    const started = assembler.consume(
      eventOf(
        "tools",
        {
          event: "tool-started",
          tool_call_id: "query-1",
          tool_name: "query_database",
          input: { table: "users" },
        },
        { namespace: ["tools:worker"], seq: 1 }
      ) as never
    );

    assembler.consume(
      eventOf(
        "tools",
        {
          event: "tool-finished",
          tool_call_id: "query-1",
          output: {
            lg_name: "Command",
            update: {
              messages: [
                {
                  type: "tool",
                  tool_call_id: "query-1",
                  name: "query_database",
                  content: JSON.stringify({ count: 2 }),
                },
              ],
            },
          },
        },
        { namespace: ["tools:worker"], seq: 2 }
      ) as never
    );

    expect(started!.output).toEqual({ count: 2 });
    await expect(started!.outputPromise).resolves.toEqual({ count: 2 });
  });
});

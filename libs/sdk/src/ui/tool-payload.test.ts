import { describe, expect, it } from "vitest";

import { parseToolOutput } from "./tool-payload.js";

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

  it("returns null for empty ToolMessage content", () => {
    expect(
      parseToolOutput({
        type: "tool",
        content: "",
        tool_call_id: "tc",
      })
    ).toBeNull();
  });
});

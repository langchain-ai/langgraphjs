import { describe, test, expectTypeOf } from "vitest";
import { createAgent, tool } from "langchain";
import { z } from "zod/v3";

import type { Message } from "../../types.messages.js";
import { useStream } from "../stream.js";

describe("useStream", () => {
  test("should properly type tool calls with results", () => {
    const getWeather = tool(async ({ location }) => `Weather in ${location}`, {
      name: "get_weather",
      schema: z.object({ location: z.string() }),
    });

    const search = tool(async ({ query }) => `Results for ${query}`, {
      name: "search",
      schema: z.object({ query: z.string() }),
    });

    const agent = createAgent({
      model: "openai:gpt-4o",
      tools: [getWeather, search],
    });
    const stream = useStream<typeof agent>({ assistantId: "test" });
    expectTypeOf(stream.messages).toEqualTypeOf<
      Message<
        | {
            name: "get_weather";
            args: {
              location: string;
            };
            id?: string | undefined;
            type?: "tool_call" | undefined;
          }
        | {
            name: "search";
            args: {
              query: string;
            };
            id?: string | undefined;
            type?: "tool_call" | undefined;
          }
      >[]
    >();

    for (const message of stream.messages) {
      if (message.type === "tool") {
        expectTypeOf(message.tool_call_id).toBeString();
      }

      if (message.type === "ai") {
        expectTypeOf(message.tool_calls).toEqualTypeOf<
          | (
              | {
                  name: "get_weather";
                  args: {
                    location: string;
                  };
                  id?: string | undefined;
                  type?: "tool_call" | undefined;
                }
              | {
                  name: "search";
                  args: {
                    query: string;
                  };
                  id?: string | undefined;
                  type?: "tool_call" | undefined;
                }
            )[]
          | undefined
        >();
      }
    }
  });
});

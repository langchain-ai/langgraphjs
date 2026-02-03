import { describe, expect, test } from "vitest";
import { effectScope } from "vue";
import { useStream } from "../vue/index.js";
import type { AIMessage, Message, ToolMessage } from "../types.messages.js";

async function waitFor(
  condition: () => boolean,
  options?: { timeoutMs?: number; intervalMs?: number }
): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? 1000;
  const intervalMs = options?.intervalMs ?? 5;
  const started = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (condition()) return;
    if (Date.now() - started > timeoutMs) {
      throw new Error("Timed out waiting for condition.");
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => {
      setTimeout(r, intervalMs);
    });
  }
}

describe("vue/useStream messages + toolCalls derivation", () => {
  test("derives messages, toolCalls, and getToolCalls()", async () => {
    type ToolCalls =
      | { name: "search"; args: { query: string }; id?: string }
      | { name: "calc"; args: { expression: string }; id?: string };

    type State = { messages: Message<ToolCalls>[] };

    const ai1: AIMessage<ToolCalls> = {
      type: "ai",
      id: "ai-1",
      content: "Calling tools",
      tool_calls: [
        { name: "search", args: { query: "q" }, id: "call-1" },
        { name: "calc", args: { expression: "1+1" }, id: "call-2" },
      ],
    };

    const tool1: ToolMessage = {
      type: "tool",
      id: "tool-1",
      content: "result search",
      tool_call_id: "call-1",
      status: "success",
    };

    const tool2: ToolMessage = {
      type: "tool",
      id: "tool-2",
      content: "result calc",
      tool_call_id: "call-2",
      status: "success",
    };

    const scope = effectScope();
    const result = scope.run(() => {
      const stream = useStream<State>({
        throttle: false,
        transport: {
          async stream() {
            async function* gen() {
              yield {
                event: "values",
                data: {
                  messages: [ai1, tool1, tool2],
                },
              };
            }
            return gen();
          },
        },
      });
      return { stream };
    });

    if (!result) throw new Error("Failed to create Vue effect scope.");

    await result.stream.submit({});

    await waitFor(() => result.stream.messages.value.length === 3);
    expect(result.stream.messages.value[0].type).toBe("ai");

    await waitFor(() => result.stream.toolCalls.value.length === 2);
    const tc = result.stream.toolCalls.value;
    expect(tc[0].call.id).toBe("call-1");
    expect(tc[0].result?.content).toBe("result search");
    expect(tc[1].call.id).toBe("call-2");
    expect(tc[1].result?.content).toBe("result calc");

    const onlyForAi1 = result.stream.getToolCalls(ai1);
    expect(onlyForAi1).toHaveLength(2);
    expect(onlyForAi1.map((x) => x.call.id)).toEqual(["call-1", "call-2"]);

    scope.stop();
  });
});

import { describe, it, expect, vi, afterEach } from "vitest";

import { StreamManager } from "./manager.js";
import { MessageTupleManager } from "./messages.js";

// `parsePartialJson` (used by @langchain/core to collapse tool call chunks)
// always tries `JSON.parse` on the accumulated args first, and the args are
// the only JSON here starting with `{"content"`, so spying on `JSON.parse`
// counts how many times, and how many characters, the args were parsed.
function argsParses(parse: { mock: { calls: unknown[][] } }) {
  const calls = parse.mock.calls
    .map(([s]) => s)
    .filter((s): s is string => typeof s === "string")
    .filter((s) => s.startsWith(`{"content"`));
  return {
    count: calls.length,
    chars: calls.reduce((sum, s) => sum + s.length, 0),
  };
}

// One AI message whose single tool call streams its args in `n` deltas,
// shaped like OpenAI: the first chunk carries id + name, the rest only args.
function* toolCallEvents(n: number, delta: string) {
  for (let i = 0; i < n; i += 1) {
    yield {
      event: "messages" as const,
      data: [
        {
          id: "ai-1",
          type: "AIMessageChunk",
          content: "",
          tool_call_chunks: [
            {
              type: "tool_call_chunk",
              index: 0,
              id: i === 0 ? "call-1" : undefined,
              name: i === 0 ? "write_file" : undefined,
              args: i === 0 ? `{"content": "` : delta,
            },
          ],
        },
        {},
      ],
    };
  }
}

// Streams `n` chunks arriving `chunkMs` apart (on fake timers).
async function streamToolCall(n: number, delta: string, chunkMs: number) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const manager = new StreamManager<any>(new MessageTupleManager(), {
    throttle: false,
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let last: any;
  const parse = vi.spyOn(JSON, "parse");
  const start = performance.now();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (manager as any).enqueue(
    async () =>
      (async function* () {
        for (const event of toolCallEvents(n, delta)) {
          yield event;
          await vi.advanceTimersByTimeAsync(chunkMs);
        }
      })(),
    {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getMessages: (values: any) => values.messages ?? [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setMessages: (current: any, msgs: any) => {
        last = msgs.at(-1);
        return { ...current, messages: msgs };
      },
      initialValues: { messages: [] },
      callbacks: {},
      onSuccess: () => null,
      onError: (e: unknown) => {
        throw e;
      },
    }
  );
  const ms = performance.now() - start;
  const parses = argsParses(parse);
  parse.mockRestore();

  return { parses, ms, last };
}

describe("StreamManager tool-call streaming cost", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("re-parses the accumulated args once per refresh, not once per chunk", async () => {
    // Fake only timers so `performance.now()` still measures real time.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const delta = "x".repeat(20);
    const chunkMs = 10;
    const results = [];
    for (const n of [250, 500, 1000, 2000]) {
      const r = await streamToolCall(n, delta, chunkMs);
      results.push({
        chunks: n,
        argsParses: r.parses.count,
        argsCharsParsed: r.parses.chars,
        argsCharsFinal: r.last.tool_calls[0].args.content.length,
        ms: Math.round(r.ms),
      });

      // Sanity: the final message has the fully streamed tool call.
      expect(r.last.tool_calls[0]).toMatchObject({
        id: "call-1",
        name: "write_file",
      });
      expect(r.last.tool_calls[0].args.content).toBe(delta.repeat(n - 1));
    }
    console.table(results);

    for (const r of results) {
      // One parse per 50ms refresh (every 5 chunks at 10ms apart), plus the
      // first chunk and the final flush, rather than one per chunk.
      expect(r.argsParses).toBeLessThanOrEqual(r.chunks / 5 + 2);
    }

    // Each refresh still parses the whole accumulated args, so the work is
    // quadratic in stream duration: doubling the chunks ~quadruples it.
    for (let i = 1; i < results.length; i += 1) {
      const ratio = results[i].argsCharsParsed / results[i - 1].argsCharsParsed;
      expect(ratio).toBeGreaterThan(3.9);
      expect(ratio).toBeLessThan(4.1);
    }
  });
});

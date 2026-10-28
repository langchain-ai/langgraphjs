import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { REMOVE_ALL_MESSAGES, StreamManager } from "./manager.js";
import { MessageTupleManager } from "./messages.js";
import { SubagentManager } from "./subagents.js";
import type { Message } from "../types.messages.js";

const DELTA = "x".repeat(20);

// One AI message whose single tool call streams its args over `n` chunks,
// shaped like OpenAI: the first chunk carries id + name, the rest only args.
function toolCallChunk(i: number, id = "ai-1"): Message {
  return {
    id,
    type: "ai",
    content: "",
    tool_call_chunks: [
      {
        type: "tool_call_chunk",
        index: 0,
        id: i === 0 ? "call-1" : undefined,
        name: i === 0 ? "write_file" : undefined,
        args: i === 0 ? `{"content": "` : DELTA,
      },
    ],
  } as Message;
}

// Tool call args are the only JSON in these tests starting with `{"content"`,
// and `parsePartialJson` always tries `JSON.parse` first, so this counts how
// many times the accumulated args were parsed.
function countArgsParses(parse: { mock: { calls: unknown[][] } }) {
  return parse.mock.calls.filter(
    ([s]) => typeof s === "string" && s.startsWith(`{"content"`)
  ).length;
}

type State = { messages: Message[] };

type MessagesEvent = { event: "messages"; data: [Message, object] };

type StreamEvent = MessagesEvent | { event: "values"; data: State };

// Runs `events` through a StreamManager and returns the AI message as
// published to state after each update.
async function streamToolCall(
  events: (
    event: (i: number) => MessagesEvent,
    published: Message[],
    currentMessages: () => Message[] | undefined
  ) => AsyncGenerator<StreamEvent>
) {
  const manager = new StreamManager<State>(new MessageTupleManager(), {
    throttle: false,
  });
  const published: Message[] = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (manager as any).enqueue(
    async () =>
      events(
        (i) => ({ event: "messages", data: [toolCallChunk(i), {}] }),
        published,
        () => manager.values?.messages
      ),
    {
      getMessages: (values: State) => values.messages ?? [],
      setMessages: (current: State, messages: Message[]) => {
        published.push(messages.at(-1)!);
        return { ...current, messages };
      },
      initialValues: { messages: [] },
      callbacks: {},
      onSuccess: () => undefined,
      onError: (e: unknown) => {
        throw e;
      },
    }
  );

  return published;
}

function argsContent(message: Message | undefined) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (message as any)?.tool_calls?.[0]?.args?.content;
}

describe("tool call args refresh", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("parses streamed args at most once per refresh interval", async () => {
    const parse = vi.spyOn(JSON, "parse");
    const n = 500;

    const published = await streamToolCall(async function* (event) {
      for (let i = 0; i < n; i += 1) {
        yield event(i);
        await vi.advanceTimersByTimeAsync(10);
      }
    });

    // 10ms per chunk and a 50ms refresh: one parse per 5 chunks, plus the
    // first chunk and the final flush.
    expect(countArgsParses(parse)).toBeLessThanOrEqual(n / 5 + 2);
    expect(argsContent(published.at(-1))).toBe(DELTA.repeat(n - 1));
  });

  it("publishes complete args from the timer once chunks stop", async () => {
    let afterRefresh: Message | undefined;

    await streamToolCall(async function* (event, published) {
      for (let i = 0; i < 10; i += 1) yield event(i);
      // No chunks for a refresh interval while the stream stays open
      await vi.advanceTimersByTimeAsync(50);
      afterRefresh = published.at(-1);
    });

    expect(argsContent(afterRefresh)).toBe(DELTA.repeat(9));
  });

  it("publishes complete args when the stream ends before a refresh", async () => {
    const published = await streamToolCall(async function* (event) {
      for (let i = 0; i < 10; i += 1) yield event(i);
    });

    expect(argsContent(published.at(-1))).toBe(DELTA.repeat(9));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("publishes complete args when the stream is aborted before a refresh", async () => {
    const published = await streamToolCall(async function* (event) {
      for (let i = 0; i < 10; i += 1) yield event(i);
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    });

    expect(argsContent(published.at(-1))).toBe(DELTA.repeat(9));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("doesn't undo a values event that lands before the refresh", async () => {
    const human = { id: "human-1", type: "human", content: "hi" } as Message;
    let afterRefresh: Message[] | undefined;

    await streamToolCall(async function* (event, _published, currentMessages) {
      for (let i = 0; i < 10; i += 1) yield event(i);
      // The server's state no longer has the streamed message
      yield { event: "values", data: { messages: [human] } };
      await vi.advanceTimersByTimeAsync(50);
      afterRefresh = currentMessages();
    });

    expect(afterRefresh).toEqual([human]);
  });

  it("doesn't undo a remove-all that lands before the refresh", async () => {
    const removeAll = {
      id: REMOVE_ALL_MESSAGES,
      type: "remove",
      content: "",
    } as unknown as Message;
    let afterRefresh: Message[] | undefined;

    await streamToolCall(async function* (event, _published, currentMessages) {
      for (let i = 0; i < 10; i += 1) yield event(i);
      yield { event: "messages", data: [removeAll, {}] };
      await vi.advanceTimersByTimeAsync(50);
      afterRefresh = currentMessages();
    });

    expect(afterRefresh).toEqual([]);
  });

  it("parses every chunk when nothing listens for refreshes", () => {
    const messages = new MessageTupleManager();

    for (let i = 0; i < 3; i += 1) {
      messages.add(toolCallChunk(i), undefined);
      const { chunk } = messages.get("ai-1")!;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(argsContent(chunk as any)).toBe(DELTA.repeat(i));
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clear cancels a pending refresh", async () => {
    const messages = new MessageTupleManager();
    messages.onRefresh = vi.fn();

    messages.add(toolCallChunk(0), undefined);
    messages.add(toolCallChunk(1), undefined);
    messages.clear();
    await vi.advanceTimersByTimeAsync(50);

    expect(messages.onRefresh).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  describe("subagents", () => {
    function createSubagentManager(onSubagentChange = vi.fn()) {
      const subagents = new SubagentManager({
        subagentToolNames: ["task"],
        onSubagentChange,
      });
      subagents.reconstructFromMessages([
        {
          type: "ai",
          id: "ai-0",
          content: "",
          tool_calls: [
            {
              id: "task-1",
              name: "task",
              args: { subagent_type: "writer", description: "Write a file" },
            },
          ],
        },
      ]);
      return subagents;
    }

    it("publishes complete args from the timer", async () => {
      const onSubagentChange = vi.fn();
      const subagents = createSubagentManager(onSubagentChange);

      for (let i = 0; i < 10; i += 1) {
        subagents.addMessageToSubagent("task-1", toolCallChunk(i, "sub-ai"));
      }
      onSubagentChange.mockClear();
      await vi.advanceTimersByTimeAsync(50);

      const { messages } = subagents.getSubagents().get("task-1")!;
      expect(onSubagentChange).toHaveBeenCalledTimes(1);
      expect(argsContent(messages.at(-1) as Message)).toBe(DELTA.repeat(9));
    });

    it("clear cancels a pending refresh", () => {
      const subagents = createSubagentManager();

      subagents.addMessageToSubagent("task-1", toolCallChunk(0, "sub-ai"));
      subagents.addMessageToSubagent("task-1", toolCallChunk(1, "sub-ai"));
      subagents.clear();

      expect(vi.getTimerCount()).toBe(0);
    });
  });
});

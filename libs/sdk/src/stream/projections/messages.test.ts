import { describe, expect, it, vi } from "vitest";
import type { AIMessageChunk } from "@langchain/core/messages";
import type { Event } from "@langchain/protocol";

import { StreamStore } from "../store.js";
import type { ThreadStream } from "../types.js";
import { messagesProjection } from "./messages.js";

const namespace = ["tools:exec-1"];

function messagesEvent(data: unknown): Event {
  return {
    type: "event",
    method: "messages",
    params: { namespace, timestamp: 0, data },
  } as Event;
}

function makeThread() {
  const queue: Event[] = [];
  const pending: Array<(result: IteratorResult<Event>) => void> = [];
  const thread = {
    subscribe: vi.fn(async () => ({
      isPaused: false,
      async unsubscribe() {},
      async waitForResume() {},
      [Symbol.asyncIterator]: () => ({
        next: () => {
          const event = queue.shift();
          if (event != null) return Promise.resolve({ done: false, value: event });
          return new Promise<IteratorResult<Event>>((resolve) => {
            pending.push(resolve);
          });
        },
      }),
    })),
  } as unknown as ThreadStream;
  const push = (...data: unknown[]) => {
    for (const item of data) {
      const event = messagesEvent(item);
      const resolve = pending.shift();
      if (resolve != null) resolve({ done: false, value: event });
      else queue.push(event);
    }
  };
  return { thread, push };
}

describe("messagesProjection", () => {
  it("streams tool-call-delta args and keeps updating past unknown delta variants", async () => {
    const { thread, push } = makeThread();
    const projection = messagesProjection(namespace);
    const store = new StreamStore(projection.initial);
    const runtime = projection.open({
      thread,
      store,
      rootBus: { channels: [], subscribe: () => () => undefined },
    });

    push(
      { event: "message-start", id: "msg_tool", role: "ai" },
      {
        event: "content-block-start",
        index: 0,
        content: { type: "tool_call_chunk", id: "call_1", name: "search", args: "" },
      },
      {
        event: "content-block-delta",
        index: 0,
        delta: { type: "tool-call-delta", args: '{"query":' },
      },
      {
        event: "content-block-delta",
        index: 0,
        delta: { type: "future-delta", args: "!!" },
      },
      {
        event: "content-block-delta",
        index: 0,
        delta: { type: "tool-call-delta", args: '"weather' },
      }
    );

    await vi.waitFor(() => {
      const [message] = store.getSnapshot() as AIMessageChunk[];
      expect(message?.tool_call_chunks).toEqual([
        {
          type: "tool_call_chunk",
          id: "call_1",
          name: "search",
          args: '{"query":"weather',
        },
      ]);
    });

    push(
      {
        event: "content-block-finish",
        index: 0,
        content: {
          type: "tool_call",
          id: "call_1",
          name: "search",
          args: { query: "weather" },
        },
      },
      { event: "message-finish", reason: "tool_use" },
      { event: "message-start", id: "msg_text", role: "ai" },
      { event: "content-block-start", index: 0, content: { type: "text", text: "Done" } },
      { event: "message-finish", reason: "stop" }
    );

    await vi.waitFor(() => {
      const [toolMessage, textMessage] = store.getSnapshot() as AIMessageChunk[];
      expect(toolMessage?.tool_calls).toEqual([
        { type: "tool_call", id: "call_1", name: "search", args: { query: "weather" } },
      ]);
      expect(textMessage?.text).toBe("Done");
    });
    await runtime.dispose();
  });
});

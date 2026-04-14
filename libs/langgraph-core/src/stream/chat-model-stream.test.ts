import { describe, expect, it } from "vitest";
import { ChatModelStreamImpl } from "./chat-model-stream.js";
import type { MessagesEventData, UsageInfo } from "./types.js";

/** Test helpers */

const textDelta = (text: string, index = 0): MessagesEventData => ({
  event: "content-block-delta",
  index,
  content_block: { type: "text", text },
});

const reasoningDelta = (
  reasoning: string,
  index = 0
): MessagesEventData => ({
  event: "content-block-delta",
  index,
  content_block: { type: "reasoning", reasoning },
});

const messageStart = (): MessagesEventData => ({
  event: "message-start",
  role: "ai",
});

const messageFinish = (
  usage?: UsageInfo
): MessagesEventData & { event: "message-finish" } => ({
  event: "message-finish",
  reason: "stop",
  usage,
});

const imageDelta = (index = 0): MessagesEventData => ({
  event: "content-block-delta",
  index,
  content_block: { type: "image", url: "https://example.com/img.png" },
});

async function collectAsync<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const results: T[] = [];
  for await (const item of iter) {
    results.push(item);
  }
  return results;
}

describe("ChatModelStreamImpl", () => {
  it("text deltas accumulate and resolve on finish", async () => {
    const stream = new ChatModelStreamImpl(["agent"], "chatModel");

    stream.pushEvent(messageStart());
    stream.pushEvent(textDelta("Hello"));
    stream.pushEvent(textDelta(", "));
    stream.pushEvent(textDelta("world!"));
    stream.finish(messageFinish());

    const fullText = await stream.text;
    expect(fullText).toBe("Hello, world!");
  });

  it("reasoning deltas accumulate and resolve on finish", async () => {
    const stream = new ChatModelStreamImpl(["agent"], "chatModel");

    stream.pushEvent(messageStart());
    stream.pushEvent(reasoningDelta("Let me "));
    stream.pushEvent(reasoningDelta("think..."));
    stream.finish(messageFinish());

    const fullReasoning = await stream.reasoning;
    expect(fullReasoning).toBe("Let me think...");
  });

  it("usage is resolved from message-finish data", async () => {
    const stream = new ChatModelStreamImpl(["agent"], "chatModel");
    const usage: UsageInfo = {
      input_tokens: 10,
      output_tokens: 25,
      total_tokens: 35,
    };

    stream.pushEvent(messageStart());
    stream.pushEvent(textDelta("hi"));
    stream.finish(messageFinish(usage));

    const result = await stream.usage;
    expect(result).toEqual(usage);
  });

  it("iterating raw events with [Symbol.asyncIterator]", async () => {
    const stream = new ChatModelStreamImpl(["agent"], "chatModel");

    const start = messageStart();
    const delta = textDelta("hi");
    const finish = messageFinish();

    stream.pushEvent(start);
    stream.pushEvent(delta);
    stream.finish(finish);

    const events = await collectAsync(stream);
    expect(events).toHaveLength(3);
    expect(events[0]).toEqual(start);
    expect(events[1]).toEqual(delta);
    expect(events[2]).toEqual(finish);
  });

  it("text getter as AsyncIterable yields deltas", async () => {
    const stream = new ChatModelStreamImpl(["agent"], "chatModel");

    stream.pushEvent(messageStart());
    stream.pushEvent(textDelta("one"));
    stream.pushEvent(textDelta("two"));
    stream.pushEvent(textDelta("three"));
    stream.finish(messageFinish());

    const deltas = await collectAsync(stream.text);
    expect(deltas).toEqual(["one", "two", "three"]);
  });

  it("text getter as PromiseLike resolves with full text", async () => {
    const stream = new ChatModelStreamImpl(["agent"], "chatModel");

    stream.pushEvent(messageStart());
    stream.pushEvent(textDelta("a"));
    stream.pushEvent(textDelta("b"));
    stream.pushEvent(textDelta("c"));
    stream.finish(messageFinish());

    const result = await stream.text.then((t) => t.toUpperCase());
    expect(result).toBe("ABC");
  });

  it("reasoning getter works same as text", async () => {
    const stream = new ChatModelStreamImpl(["agent"], "chatModel");

    stream.pushEvent(messageStart());
    stream.pushEvent(reasoningDelta("step1"));
    stream.pushEvent(reasoningDelta("step2"));
    stream.finish(messageFinish());

    const deltas = await collectAsync(stream.reasoning);
    expect(deltas).toEqual(["step1", "step2"]);

    const stream2 = new ChatModelStreamImpl(["agent"], "chatModel");
    stream2.pushEvent(messageStart());
    stream2.pushEvent(reasoningDelta("alpha"));
    stream2.pushEvent(reasoningDelta("beta"));
    stream2.finish(messageFinish());

    const full = await stream2.reasoning;
    expect(full).toBe("alphabeta");
  });

  it("fail() causes all promises to reject and iterators to throw", async () => {
    const stream = new ChatModelStreamImpl(["agent"], "chatModel");
    const error = new Error("run failed");

    stream.pushEvent(messageStart());
    stream.fail(error);

    await expect(stream.text).rejects.toThrow("run failed");
    await expect(stream.reasoning).rejects.toThrow("run failed");
    await expect(
      stream.usage.then(
        (v) => v,
        (e) => {
          throw e;
        }
      )
    ).rejects.toThrow("run failed");

    await expect(collectAsync(stream)).rejects.toThrow("run failed");
  });

  it("non-text/non-reasoning content blocks don't affect accumulators", async () => {
    const stream = new ChatModelStreamImpl(["agent"], "chatModel");

    stream.pushEvent(messageStart());
    stream.pushEvent(textDelta("hello"));
    stream.pushEvent(imageDelta());
    stream.pushEvent(reasoningDelta("think"));
    stream.finish(messageFinish());

    const text = await stream.text;
    const reasoning = await stream.reasoning;

    expect(text).toBe("hello");
    expect(reasoning).toBe("think");
  });

  it("namespace and node properties are set correctly", () => {
    const stream1 = new ChatModelStreamImpl(["agent", "inner"], "myNode");
    expect(stream1.namespace).toEqual(["agent", "inner"]);
    expect(stream1.node).toBe("myNode");

    const stream2 = new ChatModelStreamImpl([], undefined);
    expect(stream2.namespace).toEqual([]);
    expect(stream2.node).toBeUndefined();
  });
});

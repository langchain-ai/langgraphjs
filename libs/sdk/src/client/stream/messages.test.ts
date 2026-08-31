import type { AIMessageChunk } from "@langchain/core/messages";
import type { Event } from "@langchain/protocol";
import { describe, expect, it } from "vitest";

import { MessageAssembler, StreamingMessageAssembler } from "./messages.js";
import { eventOf } from "./test/utils.js";
import { assembledMessageToBaseMessage } from "../../stream/assembled-to-message.js";

describe("MessageAssembler", () => {
  it("merges text and tool chunk deltas into final message state", () => {
    const assembler = new MessageAssembler();

    assembler.consume(
      eventOf("messages", { event: "message-start", id: "msg_x" }, {
        namespace: ["agent_1"],
        node: "writer",
      }) as Extract<Event, { method: "messages" }>
    );
    assembler.consume(
      eventOf(
        "messages",
        {
          event: "content-block-start",
          index: 0,
          content: { type: "tool_call_chunk", name: "search", args: "" },
        },
        { namespace: ["agent_1"], node: "writer" }
      ) as Extract<Event, { method: "messages" }>
    );
    assembler.consume(
      eventOf(
        "messages",
        {
          event: "content-block-delta",
          index: 0,
          content: { type: "tool_call_chunk", args: '{"q":' },
        },
        { namespace: ["agent_1"], node: "writer" }
      ) as Extract<Event, { method: "messages" }>
    );
    assembler.consume(
      eventOf(
        "messages",
        {
          event: "content-block-delta",
          index: 0,
          content: { type: "tool_call_chunk", args: '"test"}' },
        },
        { namespace: ["agent_1"], node: "writer" }
      ) as Extract<Event, { method: "messages" }>
    );
    const done = assembler.consume(
      eventOf(
        "messages",
        {
          event: "content-block-finish",
          index: 0,
          content: {
            type: "tool_call",
            id: "tool_1",
            name: "search",
            args: { q: "test" },
          },
        },
        { namespace: ["agent_1"], node: "writer" }
      ) as Extract<Event, { method: "messages" }>
    );

    expect(done?.kind).toBe("content-block-finish");

    const finished = assembler.consume(
      eventOf(
        "messages",
        { event: "message-finish", reason: "tool_use" },
        { namespace: ["agent_1"], node: "writer" }
      ) as Extract<Event, { method: "messages" }>
    );

    expect(finished?.kind).toBe("message-finish");
    expect(finished?.message.blocks[0]).toEqual({
      type: "tool_call",
      id: "tool_1",
      name: "search",
      args: { q: "test" },
    });
  });

  it("preserves tool-call id/name when deltas carry null values", () => {
    // Regression test: some providers (notably Anthropic via the
    // langchain-core compat bridge) only attach the tool-call
    // identifiers to the first ``content-block-start`` chunk; every
    // subsequent ``input_json_delta`` chunk carries ``id=null,
    // name=null``. A naive ``{...target, ...delta}`` spread in
    // ``applyContentDelta`` would overwrite the captured identifiers
    // with null, making ``extractToolCallChunks`` drop the chunk and
    // causing tool-call cards to only appear at the end of the turn.
    const assembler = new MessageAssembler();

    assembler.consume(
      eventOf("messages", { event: "message-start", id: "msg_n" }, {
        namespace: ["agent_1"],
        node: "writer",
      }) as Extract<Event, { method: "messages" }>
    );
    assembler.consume(
      eventOf(
        "messages",
        {
          event: "content-block-start",
          index: 0,
          content: {
            type: "tool_call_chunk",
            id: "tool_null_test",
            name: "search",
            args: "",
          },
        },
        { namespace: ["agent_1"], node: "writer" }
      ) as Extract<Event, { method: "messages" }>
    );
    assembler.consume(
      eventOf(
        "messages",
        {
          event: "content-block-delta",
          index: 0,
          content: {
            type: "tool_call_chunk",
            id: null as unknown as string,
            name: null as unknown as string,
            args: '{"q":',
          },
        },
        { namespace: ["agent_1"], node: "writer" }
      ) as Extract<Event, { method: "messages" }>
    );
    const done = assembler.consume(
      eventOf(
        "messages",
        {
          event: "content-block-delta",
          index: 0,
          content: {
            type: "tool_call_chunk",
            id: null as unknown as string,
            name: null as unknown as string,
            args: '"test"}',
          },
        },
        { namespace: ["agent_1"], node: "writer" }
      ) as Extract<Event, { method: "messages" }>
    );

    expect(done?.kind).toBe("content-block-delta");
    // The id and name from ``content-block-start`` must survive the
    // null deltas.
    expect(done?.message.blocks[0]).toEqual({
      type: "tool_call_chunk",
      id: "tool_null_test",
      name: "search",
      args: '{"q":"test"}',
    });
  });

  it("accumulates tool-call args across block-delta events", () => {
    // Regression test: the Python v3 emitter streams tool-call arguments as
    // ``delta: { type: "block-delta", fields: { ... } }``, where each event
    // carries only the next ``args`` fragment. The ``{...current, ...fields}``
    // spread in ``applyCoreEventDelta`` replaced the fragments already
    // captured, so the block held nothing but the newest one. A bare fragment
    // does not parse, so ``collapseToolCallChunks`` moved the call to
    // ``invalid_tool_calls`` and ``AIMessageChunk`` dropped it from
    // ``tool_calls`` — blinking the tool card out for every fragment that was
    // not self-contained JSON.
    const assembler = new MessageAssembler();
    const fragments = [
      '{"start_time": "2026-08-31T12:00:00Z"',
      ', "end_time":',
      ' "2026-08-31T13:00',
      ':00Z"}',
    ];

    assembler.consume(
      eventOf("messages", { event: "message-start", id: "msg_bd" }, {
        namespace: ["agent_1"],
        node: "writer",
      }) as Extract<Event, { method: "messages" }>
    );
    assembler.consume(
      eventOf(
        "messages",
        {
          event: "content-block-start",
          index: 0,
          content: {
            type: "tool_call_chunk",
            id: "tool_block_delta",
            name: "search",
            args: "",
          },
        },
        { namespace: ["agent_1"], node: "writer" }
      ) as Extract<Event, { method: "messages" }>
    );

    let accumulated = "";
    for (const args of fragments) {
      accumulated += args;
      const update = assembler.consume(
        eventOf(
          "messages",
          {
            event: "content-block-delta",
            index: 0,
            delta: {
              type: "block-delta",
              fields: {
                type: "tool_call_chunk",
                id: "tool_block_delta",
                name: "search",
                args,
              },
            },
          } as unknown as Extract<
            Event,
            { method: "messages" }
          >["params"]["data"],
          { namespace: ["agent_1"], node: "writer" }
        ) as Extract<Event, { method: "messages" }>
      );

      expect(update?.message.blocks[0]).toEqual({
        type: "tool_call_chunk",
        id: "tool_block_delta",
        name: "search",
        args: accumulated,
      });

      // A growing prefix of valid JSON parses at every length, so the call
      // stays visible in ``tool_calls`` throughout — not only on the fragments
      // that happen to be self-contained.
      const message = assembledMessageToBaseMessage(
        update.message,
        "ai"
      ) as AIMessageChunk;
      expect(message.tool_calls?.map((call) => call.id)).toEqual([
        "tool_block_delta",
      ]);
      expect(message.invalid_tool_calls).toEqual([]);
    }
  });

  it("handles text delta concatenation", () => {
    const assembler = new MessageAssembler();

    assembler.consume(
      eventOf("messages", { event: "message-start", id: "msg_t" }, {
        namespace: [],
        node: "bot",
      }) as Extract<Event, { method: "messages" }>
    );
    assembler.consume(
      eventOf(
        "messages",
        { event: "content-block-start", index: 0, content: { type: "text", text: "" } },
        { namespace: [], node: "bot" }
      ) as Extract<Event, { method: "messages" }>
    );
    assembler.consume(
      eventOf(
        "messages",
        { event: "content-block-delta", index: 0, content: { type: "text", text: "Hel" } },
        { namespace: [], node: "bot" }
      ) as Extract<Event, { method: "messages" }>
    );
    assembler.consume(
      eventOf(
        "messages",
        { event: "content-block-delta", index: 0, content: { type: "text", text: "lo" } },
        { namespace: [], node: "bot" }
      ) as Extract<Event, { method: "messages" }>
    );
    const finished = assembler.consume(
      eventOf(
        "messages",
        { event: "message-finish", reason: "stop" },
        { namespace: [], node: "bot" }
      ) as Extract<Event, { method: "messages" }>
    );

    expect(finished?.message.id).toBe("msg_t");
    expect(finished?.message.blocks[0]).toEqual({ type: "text", text: "Hello" });
  });

  it("keeps reasoning and text deltas separate when they reuse the same protocol index", () => {
    const assembler = new MessageAssembler();

    assembler.consume(
      eventOf("messages", { event: "message-start", id: "msg_reason" }, {
        namespace: [],
        node: "bot",
      }) as Extract<Event, { method: "messages" }>
    );
    assembler.consume(
      eventOf(
        "messages",
        {
          event: "content-block-start",
          index: 0,
          content: { type: "reasoning", reasoning: "think" },
        },
        { namespace: [], node: "bot" }
      ) as Extract<Event, { method: "messages" }>
    );
    assembler.consume(
      eventOf(
        "messages",
        {
          event: "content-block-delta",
          index: 0,
          delta: { type: "reasoning-delta", reasoning: " more" },
        },
        { namespace: [], node: "bot" }
      ) as Extract<Event, { method: "messages" }>
    );
    assembler.consume(
      eventOf(
        "messages",
        {
          event: "content-block-delta",
          index: 0,
          delta: { type: "text-delta", text: "answer" },
        },
        { namespace: [], node: "bot" }
      ) as Extract<Event, { method: "messages" }>
    );
    assembler.consume(
      eventOf(
        "messages",
        {
          event: "content-block-delta",
          index: 0,
          delta: { type: "text-delta", text: " text" },
        },
        { namespace: [], node: "bot" }
      ) as Extract<Event, { method: "messages" }>
    );
    const finishedReasoning = assembler.consume(
      eventOf(
        "messages",
        {
          event: "content-block-finish",
          index: 0,
          content: { type: "reasoning", reasoning: "think more" },
        },
        { namespace: [], node: "bot" }
      ) as Extract<Event, { method: "messages" }>
    );

    expect(finishedReasoning?.message.blocks).toEqual([
      { type: "reasoning", reasoning: "think more" },
      { type: "text", text: "answer text" },
    ]);
  });

  it("preserves message id when converting assembled messages to BaseMessage", () => {
    const message = assembledMessageToBaseMessage(
      {
        id: "msg_base",
        namespace: [],
        blocks: [{ type: "text", text: "Hello" }],
      },
      "ai"
    );

    expect(message.id).toBe("msg_base");
    expect(message.text).toBe("Hello");
  });

  it("preserves reasoning blocks when converting assembled AI messages", () => {
    const message = assembledMessageToBaseMessage(
      {
        id: "msg_reasoning",
        namespace: [],
        blocks: [
          { type: "reasoning", reasoning: "Thinking through it." },
          { type: "text", text: "Final answer." },
        ],
      },
      "ai"
    );

    expect(message.id).toBe("msg_reasoning");
    expect(message.text).toBe("Final answer.");
    expect(message.contentBlocks).toEqual([
      { type: "reasoning", reasoning: "Thinking through it." },
      { type: "text", text: "Final answer." },
    ]);
  });

  it("keeps usage events from terminating message projection", () => {
    const assembler = new MessageAssembler();

    assembler.consume(
      eventOf("messages", { event: "message-start", id: "msg_usage" }, {
        namespace: [],
        node: "bot",
      }) as Extract<Event, { method: "messages" }>
    );
    assembler.consume(
      eventOf(
        "messages",
        { event: "content-block-start", index: 0, content: { type: "text", text: "" } },
        { namespace: [], node: "bot" }
      ) as Extract<Event, { method: "messages" }>
    );
    const usage = assembler.consume(
      eventOf(
        "messages",
        {
          event: "usage",
          usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
        },
        { namespace: [], node: "bot" }
      ) as Extract<Event, { method: "messages" }>
    );

    expect(usage?.kind).toBe("usage");
    expect(usage?.message.usage).toEqual({
      input_tokens: 1,
      output_tokens: 2,
      total_tokens: 3,
    });
  });

  it("handles message-error events", () => {
    const assembler = new MessageAssembler();

    assembler.consume(
      eventOf("messages", { event: "message-start", id: "msg_e" }, {
        namespace: [],
        node: "bot",
      }) as Extract<Event, { method: "messages" }>
    );
    const errUpdate = assembler.consume(
      eventOf(
        "messages",
        { event: "error", message: "Something went wrong", code: "ERR" },
        { namespace: [], node: "bot" }
      ) as Extract<Event, { method: "messages" }>
    );

    expect(errUpdate?.kind).toBe("message-error");
    expect(errUpdate?.message.error?.message).toBe("Something went wrong");
    expect(errUpdate?.message.error?.code).toBe("ERR");
  });
});

describe("StreamingMessageAssembler", () => {
  it("exposes the core ChatModelStream interface for remote messages", async () => {
    const assembler = new StreamingMessageAssembler();

    const stream = assembler.consume(
      eventOf("messages", { event: "message-start", id: "msg_s" }, {
        namespace: [],
        node: "bot",
      }) as Extract<Event, { method: "messages" }>
    );
    expect(stream).toBeDefined();

    assembler.consume(
      eventOf(
        "messages",
        { event: "content-block-start", index: 0, content: { type: "text", text: "" } },
        { namespace: [], node: "bot" }
      ) as Extract<Event, { method: "messages" }>
    );
    assembler.consume(
      eventOf(
        "messages",
        { event: "content-block-delta", index: 0, content: { type: "text", text: "Hel" } },
        { namespace: [], node: "bot" }
      ) as Extract<Event, { method: "messages" }>
    );
    assembler.consume(
      eventOf(
        "messages",
        { event: "content-block-delta", index: 0, content: { type: "text", text: "lo" } },
        { namespace: [], node: "bot" }
      ) as Extract<Event, { method: "messages" }>
    );
    assembler.consume(
      eventOf(
        "messages",
        { event: "content-block-finish", index: 0, content: { type: "text", text: "Hello" } },
        { namespace: [], node: "bot" }
      ) as Extract<Event, { method: "messages" }>
    );
    assembler.consume(
      eventOf(
        "messages",
        {
          event: "message-finish",
          reason: "stop",
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
        { namespace: [], node: "bot" }
      ) as Extract<Event, { method: "messages" }>
    );

    expect(await stream!.text).toBe("Hello");
    expect((await stream!.usage)?.total_tokens).toBe(2);
    expect((await stream!).content).toEqual([{ type: "text", text: "Hello" }]);
  });
});

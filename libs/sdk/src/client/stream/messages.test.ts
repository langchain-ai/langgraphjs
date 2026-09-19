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

  it.each([
    ["metadata", "Python", { stop_reason: "end_turn" }],
    ["responseMetadata", "JavaScript", { stop_reason: "tool_use" }],
  ] as const)(
    "preserves %s finish metadata from %s servers in converted messages",
    (key, _server, finishMetadata) => {
      const assembler = new MessageAssembler();

      assembler.consume(
        eventOf(
          "messages",
          {
            event: "message-start",
            id: "msg_metadata",
            role: "ai",
            metadata: { provider: "anthropic", model: "claude-sonnet" },
          },
          { namespace: ["agent:1"], node: "model" }
        ) as Extract<Event, { method: "messages" }>
      );
      assembler.consume(
        eventOf(
          "messages",
          {
            event: "content-block-finish",
            index: 0,
            content: { type: "text", text: "Hello" },
          },
          { namespace: ["agent:1"], node: "model" }
        ) as Extract<Event, { method: "messages" }>
      );
      const finished = assembler.consume(
        eventOf(
          "messages",
          {
            event: "message-finish",
            reason: "stop",
            [key]: finishMetadata,
          },
          { namespace: ["agent:1"], node: "model" }
        ) as Extract<Event, { method: "messages" }>
      );

      const message = assembledMessageToBaseMessage(finished!.message, "ai");
      expect(message.additional_kwargs).toEqual({
        namespace: ["agent:1"],
        node: "model",
        metadata: { provider: "anthropic", model: "claude-sonnet" },
      });
      expect(message.response_metadata).toEqual({
        finish_reason: "stop",
        ...finishMetadata,
        output_version: "v1",
      });
      expect(finished!.message.finishMetadata).toEqual(finishMetadata);
    }
  );

  it("preserves the root namespace without adding absent metadata", () => {
    const message = assembledMessageToBaseMessage(
      {
        id: "msg_plain",
        namespace: [],
        blocks: [{ type: "text", text: "Hello" }],
      },
      "ai"
    );

    expect(message.additional_kwargs).toEqual({ namespace: [] });
    expect(message.response_metadata).toEqual({ output_version: "v1" });
  });

  it("synthesizes an unknown run continuation without corrupting the active run", () => {
    const assembler = new MessageAssembler();
    const options = { namespace: ["agent_1"], node: "writer" };

    assembler.consume(
      eventOf(
        "messages",
        { event: "message-start", id: "msg_a", run_id: "run_a" },
        options
      ) as Extract<Event, { method: "messages" }>
    );
    assembler.consume(
      eventOf(
        "messages",
        {
          event: "content-block-delta",
          index: 0,
          content: { type: "text", text: "legacy" },
        },
        options
      ) as Extract<Event, { method: "messages" }>
    );
    assembler.consume(
      eventOf(
        "messages",
        {
          event: "content-block-delta",
          index: 0,
          content: { type: "text", text: "B" },
          run_id: "run_b",
        },
        options
      ) as Extract<Event, { method: "messages" }>
    );
    assembler.consume(
      eventOf(
        "messages",
        {
          event: "content-block-delta",
          index: 0,
          content: { type: "text", text: "A" },
          run_id: "run_a",
        },
        options
      ) as Extract<Event, { method: "messages" }>
    );
    const finishedB = assembler.consume(
      eventOf(
        "messages",
        { event: "message-finish", run_id: "run_b" },
        options
      ) as Extract<Event, { method: "messages" }>
    );
    const finishedA = assembler.consume(
      eventOf(
        "messages",
        { event: "message-finish", run_id: "run_a" },
        options
      ) as Extract<Event, { method: "messages" }>
    );

    expect(finishedB?.message).toMatchObject({
      runId: "run_b",
      blocks: [{ type: "text", text: "B" }],
    });
    expect(finishedA?.message).toMatchObject({
      id: "msg_a",
      runId: "run_a",
      blocks: [{ type: "text", text: "legacyA" }],
    });
  });

  it("preserves start usage when finish omits usage", () => {
    const assembler = new MessageAssembler();
    const options = { namespace: [], node: "bot" };

    assembler.consume(
      eventOf(
        "messages",
        {
          event: "message-start",
          id: "msg_usage_start",
          usage: { input_tokens: 3 },
        },
        options
      ) as Extract<Event, { method: "messages" }>
    );
    const finished = assembler.consume(
      eventOf(
        "messages",
        { event: "message-finish" },
        options
      ) as Extract<Event, { method: "messages" }>
    );

    expect(finished?.message.usage).toEqual({ input_tokens: 3 });
    const message = assembledMessageToBaseMessage(finished!.message, "ai") as {
      usage_metadata?: unknown;
      additional_kwargs: Record<string, unknown>;
    };
    expect(message.usage_metadata).toEqual({
      input_tokens: 3,
      output_tokens: 0,
      total_tokens: 0,
    });
    expect(message.additional_kwargs.usage).toEqual({ input_tokens: 3 });
  });

  it("routes interleaved streaming messages by run id", async () => {
    const assembler = new StreamingMessageAssembler();
    const options = { namespace: ["agent_1"], node: "writer" };
    const streamA = assembler.consume(
      eventOf(
        "messages",
        { event: "message-start", id: "msg_stream_a", run_id: "run_a" },
        options
      ) as Extract<Event, { method: "messages" }>
    );
    const streamB = assembler.consume(
      eventOf(
        "messages",
        { event: "message-start", id: "msg_stream_b", run_id: "run_b" },
        options
      ) as Extract<Event, { method: "messages" }>
    );

    assembler.consume(
      eventOf(
        "messages",
        {
          event: "content-block-delta",
          index: 0,
          content: { type: "text", text: "B" },
          run_id: "run_b",
        },
        options
      ) as Extract<Event, { method: "messages" }>
    );
    assembler.consume(
      eventOf(
        "messages",
        {
          event: "content-block-delta",
          index: 0,
          content: { type: "text", text: "A" },
          run_id: "run_a",
        },
        options
      ) as Extract<Event, { method: "messages" }>
    );
    assembler.consume(
      eventOf(
        "messages",
        { event: "message-finish", run_id: "run_b" },
        options
      ) as Extract<Event, { method: "messages" }>
    );
    assembler.consume(
      eventOf(
        "messages",
        { event: "message-finish", run_id: "run_a" },
        options
      ) as Extract<Event, { method: "messages" }>
    );

    await expect(streamA!.text).resolves.toBe("A");
    await expect(streamB!.text).resolves.toBe("B");
  });

  it("preserves message metadata and normalized start usage when awaited", async () => {
    const assembler = new StreamingMessageAssembler();
    const stream = assembler.consume(
      eventOf(
        "messages",
        {
          event: "message-start",
          id: "msg_await",
          run_id: "run_await",
          metadata: { provider: "openai", model: "gpt-5" },
          usage: { input_tokens: 3 },
        },
        { namespace: ["agent_1"], node: "writer" }
      ) as Extract<Event, { method: "messages" }>
    );

    assembler.consume(
      eventOf(
        "messages",
        { event: "message-finish", reason: "stop" },
        { namespace: ["agent_1"], node: "writer" }
      ) as Extract<Event, { method: "messages" }>
    );

    const message = await stream!;
    expect(message.usage_metadata).toEqual({
      input_tokens: 3,
      output_tokens: 0,
      total_tokens: 0,
    });
    expect(message.additional_kwargs).toEqual({
      namespace: ["agent_1"],
      node: "writer",
      run_id: "run_await",
      metadata: { provider: "openai", model: "gpt-5" },
      usage: { input_tokens: 3 },
    });
    expect(message.response_metadata).toEqual({
      finish_reason: "stop",
      output_version: "v1",
    });
  });

  it("preserves finish response metadata without tagging non-AI messages", () => {
    for (const role of ["human", "system", "tool"] as const) {
      const message = assembledMessageToBaseMessage(
        {
          id: `msg_${role}`,
          namespace: [],
          blocks: [{ type: "text", text: "Hello" }],
          finishMetadata: { provider_status: "complete" },
          finishReason: "stop",
        },
        role,
        { toolCallId: "call_1" }
      );

      expect(message.response_metadata).toEqual({
        finish_reason: "stop",
        provider_status: "complete",
      });

      const plainMessage = assembledMessageToBaseMessage(
        {
          id: `msg_plain_${role}`,
          namespace: [],
          blocks: [{ type: "text", text: "Hello" }],
        },
        role,
        { toolCallId: "call_1" }
      );
      expect(plainMessage.response_metadata).toEqual({});
    }
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
          metadata: { stop_reason: "end_turn" },
        },
        { namespace: [], node: "bot" }
      ) as Extract<Event, { method: "messages" }>
    );

    expect(await stream!.text).toBe("Hello");
    expect((await stream!.usage)?.total_tokens).toBe(2);
    expect((await stream!).response_metadata).toEqual({
      finish_reason: "stop",
      stop_reason: "end_turn",
      output_version: "v1",
    });
    expect((await stream!).content).toEqual([{ type: "text", text: "Hello" }]);
  });
});

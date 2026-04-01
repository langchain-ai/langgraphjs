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

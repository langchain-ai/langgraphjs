import type { Event } from "@langchain/protocol";
import { describe, expect, it } from "vitest";

import { MessageAssembler } from "./messages.js";
import { eventOf } from "./test/utils.js";

describe("MessageAssembler", () => {
  it("merges text and tool chunk deltas into final message state", () => {
    const assembler = new MessageAssembler();

    assembler.consume(
      eventOf("messages", { event: "message-start", message_id: "msg_x" }, {
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
          content_block: { type: "tool_call_chunk", name: "search", args: "" },
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
          content_block: { type: "tool_call_chunk", args: '{"q":' },
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
          content_block: { type: "tool_call_chunk", args: '"test"}' },
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
          content_block: {
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

  it("handles text delta concatenation", () => {
    const assembler = new MessageAssembler();

    assembler.consume(
      eventOf("messages", { event: "message-start", message_id: "msg_t" }, {
        namespace: [],
        node: "bot",
      }) as Extract<Event, { method: "messages" }>
    );
    assembler.consume(
      eventOf(
        "messages",
        { event: "content-block-start", index: 0, content_block: { type: "text", text: "" } },
        { namespace: [], node: "bot" }
      ) as Extract<Event, { method: "messages" }>
    );
    assembler.consume(
      eventOf(
        "messages",
        { event: "content-block-delta", index: 0, content_block: { type: "text", text: "Hel" } },
        { namespace: [], node: "bot" }
      ) as Extract<Event, { method: "messages" }>
    );
    assembler.consume(
      eventOf(
        "messages",
        { event: "content-block-delta", index: 0, content_block: { type: "text", text: "lo" } },
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

    expect(finished?.message.blocks[0]).toEqual({ type: "text", text: "Hello" });
  });

  it("handles message-error events", () => {
    const assembler = new MessageAssembler();

    assembler.consume(
      eventOf("messages", { event: "message-start", message_id: "msg_e" }, {
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

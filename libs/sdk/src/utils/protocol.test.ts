import { describe, expect, it } from "vitest";

import {
  ProtocolEventAdapter,
  getProtocolChannels,
  type ProtocolEventMessage,
} from "./protocol.js";

const createMessageEvent = (
  data: ProtocolEventMessage["params"]["data"]
): ProtocolEventMessage => ({
  type: "event",
  method: "messages",
  params: {
    namespace: [
      "tools:e0a6b650-f49e-5ee5-a373-a9b3ba63a7d5",
      "model_request:2262af10-8a47-5189-b053-f8f99a78038c",
    ],
    timestamp: Date.now(),
    data,
  },
});

describe("ProtocolEventAdapter", () => {
  it("always subscribes to the input channel for protocol sessions", () => {
    expect(getProtocolChannels(["messages-tuple", "values"])).toEqual([
      "lifecycle",
      "input",
      "messages",
      "values",
    ]);
  });

  it("preserves human message tuples from protocol message events", () => {
    const adapter = new ProtocolEventAdapter();

    expect(
      adapter.adapt(
        createMessageEvent({
          event: "message-start",
          messageId: "subagent:call_123:human",
        })
      )
    ).toEqual([]);

    const adapted = adapter.adapt(
      createMessageEvent({
        event: "content-block-delta",
        index: 0,
        contentBlock: {
          type: "text",
          text: "Research protocol details",
        },
      })
    );

    expect(adapted).toHaveLength(1);
    expect(adapted[0]).toMatchObject({
      event:
        "messages|tools:e0a6b650-f49e-5ee5-a373-a9b3ba63a7d5|model_request:2262af10-8a47-5189-b053-f8f99a78038c",
      data: [
        {
          type: "human",
          id: "subagent:call_123:human",
          content: "Research protocol details",
        },
        {
          langgraph_checkpoint_ns:
            "tools:e0a6b650-f49e-5ee5-a373-a9b3ba63a7d5|model_request:2262af10-8a47-5189-b053-f8f99a78038c",
          checkpoint_ns:
            "tools:e0a6b650-f49e-5ee5-a373-a9b3ba63a7d5|model_request:2262af10-8a47-5189-b053-f8f99a78038c",
        },
      ],
    });
  });

  it("maps input.requested events to synthetic interrupt values", () => {
    const adapter = new ProtocolEventAdapter();

    expect(
      adapter.adapt({
        type: "event",
        eventId: "evt_input_1",
        method: "input.requested",
        params: {
          namespace: [],
          timestamp: Date.now(),
          data: {
            interruptId: "interrupt_1",
            payload: {
              prompt: "Approve deployment?",
            },
          },
        },
      })
    ).toEqual([
      {
        id: "evt_input_1",
        event: "input",
        data: {
          interruptId: "interrupt_1",
          payload: {
            prompt: "Approve deployment?",
          },
        },
      },
    ]);
  });
});

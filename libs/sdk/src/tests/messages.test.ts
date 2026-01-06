import { expect, it } from "vitest";
import { MessageTupleManager, toMessageDict } from "../ui/messages.js";
import { AIMessage, Message } from "../types.messages.js";

const CHUNKS = [
  {
    type: "ai",
    id: "msg_01BhPvSREUgwkYjFzebyN3fG",
    content: [],
    additional_kwargs: {
      model: "claude-sonnet-4-5-20250929",
      id: "msg_01BhPvSREUgwkYjFzebyN3fG",
      type: "message",
      role: "assistant",
    },
    tool_call_chunks: [],
    usage_metadata: {
      input_tokens: 7987,
      output_tokens: 1,
      total_tokens: 7988,
      input_token_details: {
        cache_creation: 0,
        cache_read: 0,
      },
    },
    response_metadata: {
      model_provider: "anthropic",
      usage: {
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation: {
          ephemeral_5m_input_tokens: 0,
          ephemeral_1h_input_tokens: 0,
        },
        service_tier: "standard",
      },
    },
    tool_calls: [],
    invalid_tool_calls: [],
  },
  {
    type: "ai",
    id: "msg_01BhPvSREUgwkYjFzebyN3fG",
    content: [
      {
        index: 0,
        type: "tool_use",
        id: "toolu_018WShi1wUw7Mw5XnvVZB9mB",
        name: "ls",
        input: "",
      },
    ],
    additional_kwargs: {},
    tool_call_chunks: [
      { id: "toolu_018WShi1wUw7Mw5XnvVZB9mB", index: 0, name: "ls", args: "" },
    ],
    response_metadata: { model_provider: "anthropic" },

    tool_calls: [
      {
        name: "ls",
        args: {},
        id: "toolu_018WShi1wUw7Mw5XnvVZB9mB",
        type: "tool_call",
      },
    ],
    invalid_tool_calls: [],
  },
  {
    type: "ai",
    id: "msg_01BhPvSREUgwkYjFzebyN3fG",
    content: [{ index: 0, input: "", type: "input_json_delta" }],
    additional_kwargs: {},
    tool_call_chunks: [{ index: 0, args: "" }],
    response_metadata: { model_provider: "anthropic" },
    tool_calls: [],
    invalid_tool_calls: [
      {
        name: "",
        args: "{}",
        error: "Malformed args.",
        type: "invalid_tool_call",
      },
    ],
  },
  {
    type: "ai",
    id: "msg_01BhPvSREUgwkYjFzebyN3fG",
    content: [{ index: 0, input: '{"p', type: "input_json_delta" }],
    additional_kwargs: {},
    tool_call_chunks: [{ index: 0, args: '{"p' }],
    response_metadata: { model_provider: "anthropic" },
    tool_calls: [],
    invalid_tool_calls: [
      {
        name: "",
        args: '{"p',
        error: "Malformed args.",
        type: "invalid_tool_call",
      },
    ],
  },
  {
    type: "ai",
    id: "msg_01BhPvSREUgwkYjFzebyN3fG",
    content: [{ index: 0, input: 'ath": "/', type: "input_json_delta" }],
    additional_kwargs: {},
    tool_call_chunks: [{ index: 0, args: 'ath": "/' }],
    response_metadata: { model_provider: "anthropic" },
    tool_calls: [],
    invalid_tool_calls: [
      {
        name: "",
        args: 'ath": "/',
        error: "Malformed args.",
        type: "invalid_tool_call",
      },
    ],
  },
  {
    type: "ai",
    id: "msg_01BhPvSREUgwkYjFzebyN3fG",
    content: [
      { index: 0, input: 'very/long/path"}', type: "input_json_delta" },
    ],
    additional_kwargs: {},
    tool_call_chunks: [{ index: 0, args: 'very/long/path"}' }],
    response_metadata: { model_provider: "anthropic" },
    tool_calls: [],
    invalid_tool_calls: [
      {
        name: "",
        args: 'very/long/path"}',
        error: "Malformed args.",
        type: "invalid_tool_call",
      },
    ],
  },
  {
    type: "ai",
    id: "msg_01BhPvSREUgwkYjFzebyN3fG",
    content: [],
    additional_kwargs: {
      stop_reason: "tool_use",
      stop_sequence: null,
    },
    tool_call_chunks: [],
    usage_metadata: {
      input_tokens: 0,
      output_tokens: 51,
      total_tokens: 51,
      input_token_details: {
        cache_creation: 0,
        cache_read: 0,
      },
    },
    response_metadata: {},
    tool_calls: [],
    invalid_tool_calls: [],
  },
] as unknown as Message[];

it("tool call streaming is preserved", () => {
  const manager = new MessageTupleManager();

  const actual: AIMessage["tool_calls"][] = [];
  for (const chunk of CHUNKS) {
    manager.add(chunk, {});

    const message = manager.get("msg_01BhPvSREUgwkYjFzebyN3fG")?.chunk;
    if (!message) continue;

    actual.push((toMessageDict(message) as AIMessage).tool_calls);
  }

  expect(actual).toEqual([
    [],
    [
      {
        name: "ls",
        args: {},
        id: "toolu_018WShi1wUw7Mw5XnvVZB9mB",
        type: "tool_call",
      },
    ],
    [
      {
        name: "ls",
        args: {},
        id: "toolu_018WShi1wUw7Mw5XnvVZB9mB",
        type: "tool_call",
      },
    ],
    [
      {
        name: "ls",
        args: {},
        id: "toolu_018WShi1wUw7Mw5XnvVZB9mB",
        type: "tool_call",
      },
    ],
    [
      {
        name: "ls",
        args: { path: "/" },
        id: "toolu_018WShi1wUw7Mw5XnvVZB9mB",
        type: "tool_call",
      },
    ],
    [
      {
        name: "ls",
        args: { path: "/very/long/path" },
        id: "toolu_018WShi1wUw7Mw5XnvVZB9mB",
        type: "tool_call",
      },
    ],
    [
      {
        name: "ls",
        args: { path: "/very/long/path" },
        id: "toolu_018WShi1wUw7Mw5XnvVZB9mB",
        type: "tool_call",
      },
    ],
  ]);
});

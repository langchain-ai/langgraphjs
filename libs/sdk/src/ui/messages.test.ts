import { describe, it, expect } from "vitest";
import {
  HumanMessageChunk,
  AIMessageChunk,
  SystemMessageChunk,
  ToolMessageChunk,
  HumanMessage,
} from "@langchain/core/messages";
import type { ThreadState } from "../schema.js";
import type { Message } from "../types.messages.js";
import {
  ensureMessageInstances,
  ensureHistoryMessageInstances,
} from "./messages.js";
import { getBranchContext } from "./branching.js";

type Values = Record<string, unknown>;

function createThreadState(
  values: Values,
  overrides: Partial<ThreadState<Values>> = {}
): ThreadState<Values> {
  return {
    values,
    next: [],
    tasks: [],
    metadata: { source: "loop", step: 0, parents: {}, thread_id: "t1" },
    created_at: "2025-01-01T00:00:00.000Z",
    checkpoint: {
      thread_id: "t1",
      checkpoint_id: overrides.checkpoint?.checkpoint_id ?? "cp-1",
      checkpoint_ns: "",
      checkpoint_map: null,
    },
    parent_checkpoint: overrides.parent_checkpoint ?? null,
    ...overrides,
  };
}

const plainHuman: Message = {
  type: "human",
  content: "Hello",
  id: "msg-1",
  additional_kwargs: {},
  response_metadata: {},
};

const plainAI: Message = {
  type: "ai",
  content: "Hi there!",
  id: "msg-2",
  additional_kwargs: {},
  response_metadata: {},
  tool_calls: [],
  invalid_tool_calls: [],
} as Message;

const plainSystem: Message = {
  type: "system",
  content: "You are a helpful assistant.",
  id: "msg-3",
  additional_kwargs: {},
  response_metadata: {},
} as Message;

const plainTool: Message = {
  type: "tool",
  content: "result",
  id: "msg-4",
  tool_call_id: "tc-1",
  additional_kwargs: {},
  response_metadata: {},
} as Message;

describe("ensureMessageInstances", () => {
  it("converts plain human message to HumanMessageChunk", () => {
    const [result] = ensureMessageInstances([plainHuman]);
    expect(result).toBeInstanceOf(HumanMessageChunk);
    expect(result.content).toBe("Hello");
    expect(result.id).toBe("msg-1");
  });

  it("converts plain AI message to AIMessageChunk", () => {
    const [result] = ensureMessageInstances([plainAI]);
    expect(result).toBeInstanceOf(AIMessageChunk);
    expect(result.content).toBe("Hi there!");
  });

  it("converts plain system message to SystemMessageChunk", () => {
    const [result] = ensureMessageInstances([plainSystem]);
    expect(result).toBeInstanceOf(SystemMessageChunk);
    expect(result.content).toBe("You are a helpful assistant.");
  });

  it("converts plain tool message to ToolMessageChunk", () => {
    const [result] = ensureMessageInstances([plainTool]);
    expect(result).toBeInstanceOf(ToolMessageChunk);
    expect(result.content).toBe("result");
  });

  it("passes through existing BaseMessage instances unchanged", () => {
    const instance = new HumanMessage({ content: "Already a class", id: "x" });
    const [result] = ensureMessageInstances([instance]);
    expect(result).toBe(instance);
  });

  it("handles mixed plain objects and class instances", () => {
    const instance = new HumanMessage({ content: "class", id: "x" });
    const results = ensureMessageInstances([plainHuman, instance, plainAI]);
    expect(results[0]).toBeInstanceOf(HumanMessageChunk);
    expect(results[1]).toBe(instance);
    expect(results[2]).toBeInstanceOf(AIMessageChunk);
  });
});

describe("ensureHistoryMessageInstances", () => {
  it("converts messages in history state values to BaseMessage instances", () => {
    const history = [createThreadState({ messages: [plainHuman, plainAI] })];

    const result = ensureHistoryMessageInstances(history);

    expect(result).toHaveLength(1);
    const messages = result[0].values.messages as unknown[];
    expect(messages).toHaveLength(2);
    expect(messages[0]).toBeInstanceOf(HumanMessageChunk);
    expect(messages[1]).toBeInstanceOf(AIMessageChunk);
  });

  it("converts all message types across multiple states", () => {
    const history = [
      createThreadState(
        { messages: [plainHuman] },
        {
          checkpoint: {
            thread_id: "t1",
            checkpoint_id: "cp-1",
            checkpoint_ns: "",
            checkpoint_map: null,
          },
        }
      ),
      createThreadState(
        { messages: [plainHuman, plainAI, plainTool] },
        {
          checkpoint: {
            thread_id: "t1",
            checkpoint_id: "cp-2",
            checkpoint_ns: "",
            checkpoint_map: null,
          },
          parent_checkpoint: {
            thread_id: "t1",
            checkpoint_id: "cp-1",
            checkpoint_ns: "",
            checkpoint_map: null,
          },
        }
      ),
    ];

    const result = ensureHistoryMessageInstances(history);

    const msgs0 = result[0].values.messages as unknown[];
    expect(msgs0[0]).toBeInstanceOf(HumanMessageChunk);

    const msgs1 = result[1].values.messages as unknown[];
    expect(msgs1[0]).toBeInstanceOf(HumanMessageChunk);
    expect(msgs1[1]).toBeInstanceOf(AIMessageChunk);
    expect(msgs1[2]).toBeInstanceOf(ToolMessageChunk);
  });

  it("passes through states without message arrays unchanged", () => {
    const state = createThreadState({ counter: 42 });
    const result = ensureHistoryMessageInstances([state]);

    expect(result[0]).toBe(state);
    expect(result[0].values).toEqual({ counter: 42 });
  });

  it("handles states with empty messages array", () => {
    const history = [createThreadState({ messages: [] })];
    const result = ensureHistoryMessageInstances(history);
    expect((result[0].values.messages as unknown[]).length).toBe(0);
  });

  it("supports custom messagesKey", () => {
    const history = [createThreadState({ chat: [plainHuman, plainAI] })];

    const result = ensureHistoryMessageInstances(history, "chat");

    const messages = result[0].values.chat as unknown[];
    expect(messages[0]).toBeInstanceOf(HumanMessageChunk);
    expect(messages[1]).toBeInstanceOf(AIMessageChunk);
  });

  it("preserves other state properties", () => {
    const state = createThreadState({
      messages: [plainHuman],
      otherData: "preserved",
    });
    const result = ensureHistoryMessageInstances([state]);

    expect(result[0].values.otherData).toBe("preserved");
    expect(result[0].next).toEqual([]);
    expect(result[0].checkpoint).toEqual(state.checkpoint);
    expect(result[0].metadata).toEqual(state.metadata);
  });

  it("does not mutate original history array or states", () => {
    const history = [createThreadState({ messages: [plainHuman] })];
    const originalMessages = history[0].values.messages;

    ensureHistoryMessageInstances(history);

    expect(history[0].values.messages).toBe(originalMessages);
    expect(typeof (history[0].values.messages as Message[])[0].type).toBe(
      "string"
    );
    expect((history[0].values.messages as Message[])[0]).not.toBeInstanceOf(
      HumanMessageChunk
    );
  });
});

describe("functional graph (values: null)", () => {
  it("ensureHistoryMessageInstances passes through states with null values", () => {
    const history = [
      createThreadState({ messages: [plainHuman, plainAI] }),
      createThreadState({ messages: [] } as unknown as Values),
      createThreadState(null as unknown as Values),
    ];

    const result = ensureHistoryMessageInstances(history);
    expect(result).toHaveLength(3);

    const msgs = result[0].values.messages as unknown[];
    expect(msgs[0]).toBeInstanceOf(HumanMessageChunk);
    expect(msgs[1]).toBeInstanceOf(AIMessageChunk);

    expect(result[2].values).toBeNull();
    expect(result[2]).toBe(history[2]);
  });
});

describe("base SDK history returns plain Message dicts (no class instances)", () => {
  it("messages in history are plain objects with type/content fields", () => {
    const history = [createThreadState({ messages: [plainHuman, plainAI] })];

    const msgs = history[0].values.messages as Message[];
    expect(msgs[0]).toEqual(plainHuman);
    expect(msgs[1]).toEqual(plainAI);

    expect(msgs[0]).not.toBeInstanceOf(HumanMessageChunk);
    expect(msgs[1]).not.toBeInstanceOf(AIMessageChunk);

    expect(typeof (msgs[0] as Record<string, unknown>).getType).toBe(
      "undefined"
    );
    expect(typeof (msgs[1] as Record<string, unknown>).getType).toBe(
      "undefined"
    );

    expect(msgs[0].type).toBe("human");
    expect(msgs[1].type).toBe("ai");
  });
});

describe("base SDK getBranchContext returns plain objects (no conversion)", () => {
  const historyFixture: ThreadState<Values>[] = [
    createThreadState(
      {
        messages: [
          { type: "human", content: "Hello", id: "m1" },
          { type: "ai", content: "Hey", id: "m2" },
        ],
      },
      {
        checkpoint: {
          thread_id: "t1",
          checkpoint_id: "cp-2",
          checkpoint_ns: "",
          checkpoint_map: null,
        },
        parent_checkpoint: {
          thread_id: "t1",
          checkpoint_id: "cp-1",
          checkpoint_ns: "",
          checkpoint_map: null,
        },
      }
    ),
    createThreadState(
      {
        messages: [{ type: "human", content: "Hello", id: "m1" }],
      },
      {
        checkpoint: {
          thread_id: "t1",
          checkpoint_id: "cp-1",
          checkpoint_ns: "",
          checkpoint_map: null,
        },
        parent_checkpoint: null,
      }
    ),
  ];

  it("flatHistory contains plain message objects, not BaseMessage instances", () => {
    const { flatHistory } = getBranchContext("", historyFixture);

    expect(flatHistory).toHaveLength(2);

    // flatHistory is ordered root-first: cp-1 (1 msg), then cp-2 (2 msgs)
    const lastState = flatHistory[flatHistory.length - 1];
    const messages = lastState.values.messages as Record<string, unknown>[];
    expect(messages).toHaveLength(2);

    expect(typeof (messages[0] as Record<string, unknown>).getType).toBe(
      "undefined"
    );
    expect(typeof (messages[1] as Record<string, unknown>).getType).toBe(
      "undefined"
    );
    expect(messages[0]).not.toBeInstanceOf(HumanMessageChunk);
    expect(messages[1]).not.toBeInstanceOf(AIMessageChunk);

    expect(messages[0]).toEqual({ type: "human", content: "Hello", id: "m1" });
    expect(messages[1]).toEqual({ type: "ai", content: "Hey", id: "m2" });
  });

  it("flatHistory messages become BaseMessage after ensureHistoryMessageInstances", () => {
    const { flatHistory } = getBranchContext("", historyFixture);
    const converted = ensureHistoryMessageInstances(flatHistory);

    const lastConverted = converted[converted.length - 1];
    const messages = lastConverted.values.messages as unknown[];
    expect(messages).toHaveLength(2);
    expect(messages[0]).toBeInstanceOf(HumanMessageChunk);
    expect(messages[1]).toBeInstanceOf(AIMessageChunk);

    // Original flatHistory is untouched
    const lastOrig = flatHistory[flatHistory.length - 1];
    const origMessages = lastOrig.values.messages as Record<string, unknown>[];
    expect(origMessages[0]).not.toBeInstanceOf(HumanMessageChunk);
  });
});

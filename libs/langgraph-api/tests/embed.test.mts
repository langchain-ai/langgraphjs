import type {
  BaseMessageFields,
  BaseMessageLike,
  MessageType,
} from "@langchain/core/messages";
import {
  Client,
  type MessagesTupleStreamEvent,
} from "@langchain/langgraph-sdk";
import { beforeEach, describe, expect, it } from "vitest";
import { findLast, gatherIterator } from "./utils.mjs";
import {
  createEmbedServer,
  type ThreadSaver,
} from "../src/experimental/embed.mjs";
import { MemorySaver } from "@langchain/langgraph-checkpoint";

const threads = (() => {
  const THREAD_ORDER = Symbol.for("lg_thread_order");

  let THREADS: Record<
    string,
    {
      thread_id: string;
      metadata: Record<string, unknown>;
      created_at: Date;
      updated_at: Date;
      [THREAD_ORDER]: number;
    }
  > = {};

  return {
    get: async (id) => THREADS[id],
    set: async (threadId, { kind, metadata }) => {
      const now = new Date();

      THREADS[threadId] ??= {
        thread_id: threadId,
        metadata: {},
        created_at: now,
        updated_at: now,
        [THREAD_ORDER]: Object.keys(THREADS).length,
      };

      THREADS[threadId].updated_at = now;
      THREADS[threadId].metadata = {
        ...(kind === "patch" && THREADS[threadId].metadata),
        ...metadata,
      };

      return THREADS[threadId];
    },
    delete: async (threadId) => void delete THREADS[threadId],
    async *search(options: {
      metadata?: Record<string, unknown>;
      limit: number;
      offset: number;
      sortBy: "created_at" | "updated_at";
      sortOrder: "asc" | "desc";
    }) {
      const filtered = Object.values(THREADS)
        .filter((thread) => {
          if (options.metadata != null) {
            return Object.entries(options.metadata).every(
              ([key, value]) => thread.metadata[key] === value
            );
          }

          return true;
        })
        .sort((a, b) => {
          const aValue = a[options.sortBy];
          const bValue = b[options.sortBy];

          if (aValue == null || bValue == null) return 0;
          if (aValue < bValue) return options.sortOrder === "asc" ? -1 : 1;
          if (aValue > bValue) return options.sortOrder === "asc" ? 1 : -1;
          return options.sortOrder === "asc"
            ? a[THREAD_ORDER] - b[THREAD_ORDER]
            : b[THREAD_ORDER] - a[THREAD_ORDER];
        });

      const total = filtered.length;
      yield* filtered
        .slice(options.offset, options.offset + options.limit)
        .map((thread) => ({ thread, total }));
    },
    truncate: () => {
      THREADS = {};
    },
  };
})() satisfies ThreadSaver;

const server = createEmbedServer({
  graph: {
    agent: await import("./graphs/agent.mjs").then((m) => m.graph),
    nested: await import("./graphs/nested.mjs").then((m) => m.graph),
    weather: await import("./graphs/weather.mjs").then((m) => m.graph),
    error: await import("./graphs/error.mjs").then((m) => m.graph),
    delay: await import("./graphs/delay.mjs").then((m) => m.graph),
    simple_runtime: await import("./graphs/simple_runtime.mjs").then(
      (m) => m.graph
    ),
  },
  checkpointer: new MemorySaver(),
  threads,
});

const client = new Client<any>({ callerOptions: { fetch: server.request } });

// Passed to all invocation requests as the graph now requires this field to be present
// in `configurable` due to a new `SharedValue` field requiring it.
const globalConfig = { configurable: { user_id: "123" } };

// TODO: this is not exported anywhere in JS
// we should support only the flattened one
type BaseMessage = {
  type: MessageType | "user" | "assistant" | "placeholder";
} & BaseMessageFields;

interface AgentState {
  messages: Array<BaseMessage>;
}

describe("threads crud", () => {
  beforeEach(() => threads.truncate());

  it("create, read, update, delete thread", async () => {
    const metadata = { name: "test_thread" };

    const threadOne = await client.threads.create({ metadata });
    expect(threadOne.metadata).toEqual(metadata);

    let get = await client.threads.get(threadOne.thread_id);
    expect(get.thread_id).toBe(threadOne.thread_id);
    expect(get.metadata).toEqual(metadata);

    await client.threads.update(threadOne.thread_id, {
      metadata: { modified: true },
    });

    get = await client.threads.get(threadOne.thread_id);
    expect(get.metadata).toEqual({ ...metadata, modified: true });

    const threadTwo = await client.threads.create({
      metadata: { name: "another_thread" },
    });
    let search = await client.threads.search();
    expect(search.length).toBe(2);
    expect(search[0].thread_id).toBe(threadTwo.thread_id);
    expect(search[1].thread_id).toBe(threadOne.thread_id);

    search = await client.threads.search({ metadata: { modified: true } });
    expect(search.length).toBe(1);
    expect(search[0].thread_id).toBe(threadOne.thread_id);

    await client.threads.delete(threadOne.thread_id);
    search = await client.threads.search();

    expect(search.length).toBe(1);
    expect(search[0].thread_id).toBe(threadTwo.thread_id);
  });

  it("list threads", async () => {
    let search = await client.threads.search();
    expect(search.length).toBe(0);

    // test adding a single thread w/o metadata
    const createThreadResponse = await client.threads.create();
    search = await client.threads.search();

    expect(search.length).toBe(1);
    expect(createThreadResponse.thread_id).toBe(search[0].thread_id);

    // test adding a thread w/ metadata
    const metadata = { name: "test_thread" };
    const create = await client.threads.create({ metadata });

    search = await client.threads.search();
    expect(search.length).toBe(2);
    expect(create.thread_id).toBe(search[0].thread_id);

    // test filtering on metadata
    search = await client.threads.search({ metadata });
    expect(search.length).toBe(1);
    expect(create.thread_id).toBe(search[0].thread_id);

    // test pagination
    search = await client.threads.search({ offset: 1, limit: 1 });
    expect(search.length).toBe(1);
    expect(createThreadResponse.thread_id).toBe(search[0].thread_id);

    // test sorting
    search = await client.threads.search({
      sortBy: "created_at",
      sortOrder: "asc",
    });
    expect(search.length).toBe(2);
    expect(search[0].thread_id).toBe(createThreadResponse.thread_id);
    expect(search[1].thread_id).toBe(create.thread_id);

    search = await client.threads.search({
      sortBy: "created_at",
      sortOrder: "desc",
    });
    expect(search.length).toBe(2);
    expect(search[0].thread_id).toBe(create.thread_id);
    expect(search[1].thread_id).toBe(createThreadResponse.thread_id);
  });
});

describe("runs", () => {
  it.concurrent("stream values", async () => {
    const thread = await client.threads.create();
    const input = {
      messages: [{ type: "human", content: "foo", id: "initial-message" }],
    };
    const stream = client.runs.stream(thread.thread_id, "agent", {
      input,
      streamMode: "values",
      config: globalConfig,
    });

    let previousMessageIds = [];
    const seenEventTypes = new Set();

    let chunk: any;
    for await (chunk of stream) {
      seenEventTypes.add(chunk.event);

      if (chunk.event === "values") {
        const messageIds = chunk.data.messages.map(
          (message: { id: string }) => message.id
        );
        expect(messageIds.slice(0, -1)).toEqual(previousMessageIds);
        previousMessageIds = messageIds;
      }
    }

    expect(chunk.event).toBe("values");
    expect(seenEventTypes).toEqual(new Set(["metadata", "values"]));

    const runCheckpoints = await client.threads.getHistory(thread.thread_id);
    expect(runCheckpoints.length).toBeGreaterThan(1);
  });

  it.concurrent("stream updates", async () => {
    const thread = await client.threads.create();
    const input = {
      messages: [{ type: "human", content: "foo", id: "initial-message" }],
    };
    const stream = client.runs.stream(thread.thread_id, "agent", {
      input,
      streamMode: "updates",
      config: globalConfig,
    });

    const seenEventTypes = new Set();
    const seenNodes: string[] = [];

    let chunk: any;
    for await (chunk of stream) {
      seenEventTypes.add(chunk.event);

      if (chunk.event === "updates") {
        const node = Object.keys(chunk.data)[0];
        seenNodes.push(node);
      }
    }

    expect(seenNodes).toEqual(["agent", "tool", "agent"]);

    expect(chunk.event).toBe("updates");
    expect(seenEventTypes).toEqual(new Set(["metadata", "updates"]));
  });

  it.concurrent("stream events", async () => {
    const thread = await client.threads.create();
    const input = {
      messages: [{ type: "human", content: "foo", id: "initial-message" }],
    };
    const stream = client.runs.stream(thread.thread_id, "agent", {
      input,
      streamMode: "events",
      config: globalConfig,
    });

    const events = await gatherIterator(stream);
    expect(new Set(events.map((i) => i.event))).toEqual(
      new Set(["metadata", "events"])
    );

    expect(
      new Set(
        events
          .filter((i) => i.event === "events")
          .map((i) => (i.data as any).event)
      )
    ).toEqual(
      new Set([
        "on_chain_start",
        "on_chain_end",
        "on_chat_model_end",
        "on_chat_model_start",
        "on_chat_model_stream",
      ])
    );
  });

  it.concurrent("stream messages", async () => {
    const thread = await client.threads.create();
    const input = {
      messages: [{ type: "human", content: "foo", id: "initial-message" }],
    };
    const stream = client.runs.stream(thread.thread_id, "agent", {
      input,
      streamMode: "messages",
      config: globalConfig,
    });

    const seenEventTypes = new Set();
    const messageIdToContent: Record<string, string> = {};
    let lastMessage: any = null;

    let chunk: any;
    for await (chunk of stream) {
      seenEventTypes.add(chunk.event);

      if (chunk.event === "messages/partial") {
        const message = chunk.data[0];
        messageIdToContent[message.id] = message.content;
      }

      if (chunk.event === "messages/complete") {
        const message = chunk.data[0];
        expect(message.content).not.toBeNull();
        if (message.type === "ai") {
          expect(message.content).toBe(messageIdToContent[message.id]);
        }
        lastMessage = message;
      }
    }

    expect(lastMessage).not.toBeNull();
    expect(lastMessage.content).toBe("end");

    expect(chunk.event).toBe("messages/complete");
    expect(seenEventTypes).toEqual(
      new Set([
        "metadata",
        "messages/metadata",
        "messages/partial",
        "messages/complete",
      ])
    );
  });

  it.concurrent("stream messages tuple", async () => {
    const thread = await client.threads.create();
    const input = {
      messages: [{ type: "human", content: "foo", id: "initial-message" }],
    };
    const stream = await client.runs.stream(thread.thread_id, "agent", {
      input,
      streamMode: "messages-tuple",
      config: globalConfig,
      streamSubgraphs: true,
    });

    const chunks = await gatherIterator(stream);
    const runId = findLast(chunks, (i) => i.event === "metadata")?.data.run_id;
    expect(runId).not.toBeUndefined();
    expect(runId).not.toBeNull();

    const messages = chunks
      .filter(
        (i): i is MessagesTupleStreamEvent =>
          i.event.startsWith("messages|") || i.event === "messages"
      )
      .map((i) => i.data[0]);

    expect(messages).toHaveLength("begin".length + "end".length + 1);
    expect(messages).toMatchObject([
      ..."begin".split("").map((c) => ({ content: c })),
      { content: "tool_call__begin" },
      ..."end".split("").map((c) => ({ content: c })),
    ]);

    const seenEventTypes = new Set(chunks.map((i) => i.event.split("|")[0]));
    expect(seenEventTypes).toEqual(new Set(["metadata", "messages"]));
  });

  it.concurrent("stream mixed modes", async () => {
    const thread = await client.threads.create();
    const input = {
      messages: [{ type: "human", content: "foo", id: "initial-message" }],
    };
    const stream = await client.runs.stream(thread.thread_id, "agent", {
      input,
      streamMode: ["messages", "values"],
      config: globalConfig,
    });

    const chunks = await gatherIterator(stream);
    expect(chunks.at(-1)?.event).toBe("messages/complete");
    expect(chunks.filter((i) => i.event === "error").length).toBe(0);

    const messages: BaseMessage[] = findLast(
      chunks,
      (i) => i.event === "values"
    )?.data.messages;

    expect(messages.length).toBe(4);
    expect(messages.at(-1)?.content).toBe("end");

    const runId = findLast(chunks, (i) => i.event === "metadata")?.data.run_id;
    expect(runId).not.toBeNull();

    const seenEventTypes = new Set(chunks.map((i) => i.event));
    expect(seenEventTypes).toEqual(
      new Set([
        "metadata",
        "messages/metadata",
        "messages/partial",
        "messages/complete",
        "values",
      ])
    );
  });

  it.concurrent(
    "human in the loop - no modification",
    { retry: 0 },
    async () => {
      const graphId = "agent";
      const thread = await client.threads.create();
      const input = {
        messages: [{ type: "human", content: "foo", id: "initial-message" }],
      };
      let messages: BaseMessage[] = [];

      // (1) interrupt and then continue running, no modification
      // run until the interrupt
      let chunks = await gatherIterator(
        client.runs.stream(thread.thread_id, graphId, {
          input,
          interruptBefore: ["tool"],
          config: globalConfig,
        })
      );

      expect(chunks.filter((i) => i.event === "error").length).toBe(0);
      messages =
        findLast(
          chunks,
          (i): i is { event: "values"; data: { messages: BaseMessage[] } } =>
            i.event === "values" && "messages" in i.data
        )?.data.messages ?? [];

      expect(messages.at(-1)).not.toBeNull();
      expect(messages.at(-1)?.content).toBe("begin");

      const state = await client.threads.getState(thread.thread_id);
      expect(state.next).toEqual(["tool"]);

      // continue after interrupt
      chunks = await gatherIterator(
        client.runs.stream(thread.thread_id, graphId, {
          input: null,
          config: globalConfig,
        })
      );

      expect(chunks.filter((i) => i.event === "error").length).toBe(0);
      messages = findLast(chunks, (i) => i.event === "values")?.data.messages;

      expect(messages.length).toBe(4);
      expect(messages[2].content).toBe("tool_call__begin");
      expect(messages.at(-1)?.content).toBe("end");
    }
  );

  it.concurrent("human in the loop - modification", async () => {
    // (2) interrupt, modify the message and then continue running
    const graphId = "agent";
    const thread = await client.threads.create();
    const input = {
      messages: [{ type: "human", content: "foo", id: "initial-message" }],
    };
    let messages: BaseMessage[] = [];

    // run until the interrupt
    let chunks = await gatherIterator(
      client.runs.stream(thread.thread_id, graphId, {
        input,
        interruptBefore: ["tool"],
        config: globalConfig,
      })
    );

    expect(chunks.filter((i) => i.event === "error").length).toBe(0);

    // edit the last message
    const lastMessage =
      findLast(
        chunks,
        (i): i is { event: "values"; data: { messages: BaseMessage[] } } =>
          i.event === "values" && "messages" in i.data
      )?.data.messages.at(-1) ?? null;

    if (!lastMessage) throw new Error("No last message");
    lastMessage.content = "modified";

    // update state
    await client.threads.updateState<AgentState>(thread.thread_id, {
      values: { messages: [lastMessage] },
    });
    await client.threads.update(thread.thread_id, {
      metadata: { modified: true },
    });

    const stateAfterModify = await client.threads.getState<AgentState>(
      thread.thread_id
    );
    expect(stateAfterModify.values.messages.at(-1)?.content).toBe("modified");
    expect(stateAfterModify.next).toEqual(["tool"]);
    expect(stateAfterModify.tasks).toMatchObject([
      { id: expect.any(String), name: "tool", error: null, interrupts: [] },
    ]);

    // continue after interrupt
    chunks = await gatherIterator(
      client.runs.stream(thread.thread_id, graphId, {
        input: null,
        config: globalConfig,
      })
    );

    expect(chunks.filter((i) => i.event === "error").length).toBe(0);
    messages = findLast(chunks, (i) => i.event === "values")?.data.messages;

    expect(messages.length).toBe(4);
    expect(messages[2].content).toBe(`tool_call__modified`);
    expect(messages.at(-1)?.content).toBe("end");

    // get the history
    const history = await client.threads.getHistory<AgentState>(
      thread.thread_id
    );
    expect(history.length).toBe(6);
    expect(history[0].next.length).toBe(0);
    expect(history[0].values.messages.length).toBe(4);
    expect(history.at(-1)?.next).toEqual(["__start__"]);
  });

  it.concurrent("errors", async () => {
    const thread = await client.threads.create();
    const stream = await gatherIterator(
      client.runs.stream(thread.thread_id, "error", {
        input: { messages: [] },
      })
    );

    expect(stream.at(-1)).toMatchObject({
      event: "error",
      data: {
        error: "CustomError",
        message: "Boo!",
      },
    });
  });
});

describe("subgraphs", () => {
  // (1) interrupt and then continue running, no modification
  it.concurrent("human in the loop - no modification", async () => {
    const graphId = "weather";
    const thread = await client.threads.create();

    // run until the interrupt
    let lastMessageBeforeInterrupt: { content?: string } | null = null;
    let chunks = await gatherIterator(
      client.runs.stream(thread.thread_id, graphId, {
        input: {
          messages: [{ role: "human", content: "SF", id: "initial-message" }],
        },
        interruptBefore: ["tool"],
      })
    );

    for (const chunk of chunks) {
      if (chunk.event === "values" && "messages" in chunk.data) {
        lastMessageBeforeInterrupt =
          chunk.data.messages[chunk.data.messages.length - 1];
      }

      if (chunk.event === "error") {
        throw new Error(chunk.data.error);
      }
    }

    expect(lastMessageBeforeInterrupt?.content).toBe("SF");
    expect(chunks).toEqual([
      {
        event: "metadata",
        data: { run_id: expect.any(String), attempt: 1 },
      },
      {
        event: "values",
        data: {
          messages: [
            {
              content: "SF",
              additional_kwargs: {},
              response_metadata: {},
              type: "human",
              id: "initial-message",
            },
          ],
        },
      },
      {
        event: "values",
        data: {
          messages: [
            {
              content: "SF",
              additional_kwargs: {},
              response_metadata: {},
              type: "human",
              id: "initial-message",
            },
          ],
          route: "weather",
        },
      },
      {
        data: {
          __interrupt__: [],
        },
        event: "values",
      },
    ]);

    let state = await client.threads.getState(thread.thread_id);
    expect(state.next).toEqual(["weather_graph"]);
    expect(state.tasks).toEqual([
      {
        id: expect.any(String),
        name: "weather_graph",
        path: ["__pregel_pull", "weather_graph"],
        error: null,
        interrupts: [],
        checkpoint: {
          checkpoint_ns: expect.stringMatching(/^weather_graph:/),
          thread_id: expect.any(String),
        },
        state: null,
        result: null,
      },
    ]);

    const stateRecursive = await client.threads.getState(
      thread.thread_id,
      undefined,
      { subgraphs: true }
    );

    expect(stateRecursive.next).toEqual(["weather_graph"]);
    expect(stateRecursive.tasks).toEqual([
      {
        id: expect.any(String),
        name: "weather_graph",
        path: ["__pregel_pull", "weather_graph"],
        error: null,
        interrupts: [],
        checkpoint: null,
        result: null,
        state: {
          values: {
            city: "San Francisco",
            messages: [
              {
                content: "SF",
                additional_kwargs: {},
                response_metadata: {},
                type: "human",
                id: "initial-message",
              },
            ],
          },
          next: ["weather_node"],
          tasks: [
            {
              id: expect.any(String),
              name: "weather_node",
              path: ["__pregel_pull", "weather_node"],
              error: null,
              interrupts: [],
              checkpoint: null,
              state: null,
              result: null,
            },
          ],
          metadata: expect.any(Object),
          created_at: expect.any(String),
          checkpoint: expect.any(Object),
          parent_checkpoint: expect.any(Object),
          // TODO: Deprecated, double-check if not used in Studio
          // checkpoint_id: expect.any(String),
          // parent_checkpoint_id: expect.any(String),
        },
      },
    ]);

    // continue after interrupt
    const chunksSubgraph = await gatherIterator(
      client.runs.stream(thread.thread_id, graphId, {
        input: null,
        streamMode: ["values", "updates"],
        streamSubgraphs: true,
      })
    );

    expect(chunksSubgraph.filter((i) => i.event === "error")).toEqual([]);
    expect(chunksSubgraph.at(-1)?.event).toBe("values");

    const continueMessages = chunksSubgraph.findLast(
      (i) => i.event === "values"
    )?.data.messages;

    expect(continueMessages.length).toBe(2);
    expect(continueMessages[0].content).toBe("SF");
    expect(continueMessages[1].content).toBe("It's sunny in San Francisco!");
    expect(chunksSubgraph).toEqual([
      {
        event: "metadata",
        data: { run_id: expect.any(String), attempt: 1 },
      },
      {
        event: "values",
        data: {
          messages: [
            {
              content: "SF",
              additional_kwargs: {},
              response_metadata: {},
              type: "human",
              id: "initial-message",
            },
          ],
          route: "weather",
        },
      },
      {
        event: expect.stringMatching(/^values\|weather_graph:/),
        data: {
          messages: [
            {
              content: "SF",
              additional_kwargs: {},
              response_metadata: {},
              type: "human",
              id: "initial-message",
            },
          ],
          city: "San Francisco",
        },
      },
      {
        event: expect.stringMatching(/^updates\|weather_graph:/),
        data: {
          weather_node: {
            messages: [
              {
                content: "It's sunny in San Francisco!",
                additional_kwargs: {},
                response_metadata: {},
                type: "ai",
                id: expect.any(String),
                tool_calls: [],
                invalid_tool_calls: [],
              },
            ],
          },
        },
      },
      {
        event: expect.stringMatching(/^values\|weather_graph:/),
        data: {
          messages: [
            {
              content: "SF",
              additional_kwargs: {},
              response_metadata: {},
              type: "human",
              id: "initial-message",
            },
            {
              content: "It's sunny in San Francisco!",
              additional_kwargs: {},
              response_metadata: {},
              type: "ai",
              id: expect.any(String),
              tool_calls: [],
              invalid_tool_calls: [],
            },
          ],
          city: "San Francisco",
        },
      },
      {
        event: "updates",
        data: {
          weather_graph: {
            messages: [
              {
                content: "SF",
                additional_kwargs: {},
                response_metadata: {},
                type: "human",
                id: "initial-message",
              },
              {
                content: "It's sunny in San Francisco!",
                additional_kwargs: {},
                response_metadata: {},
                type: "ai",
                id: expect.any(String),
                tool_calls: [],
                invalid_tool_calls: [],
              },
            ],
          },
        },
      },
      {
        event: "values",
        data: {
          messages: [
            {
              content: "SF",
              additional_kwargs: {},
              response_metadata: {},
              type: "human",
              id: "initial-message",
            },
            {
              content: "It's sunny in San Francisco!",
              additional_kwargs: {},
              response_metadata: {},
              type: "ai",
              id: expect.any(String),
              tool_calls: [],
              invalid_tool_calls: [],
            },
          ],
          route: "weather",
        },
      },
    ]);
  });

  // (2) interrupt, modify the message and then continue running
  it.concurrent("human in the loop - modification", async () => {
    const graphId = "weather";
    const thread = await client.threads.create();
    const input = {
      messages: [{ role: "human", content: "SF", id: "initial-message" }],
    };

    // run until the interrupt (same as before)
    let chunks = await gatherIterator(
      client.runs.stream(thread.thread_id, graphId, { input })
    );
    expect(chunks.filter((i) => i.event === "error")).toEqual([]);

    // get state after interrupt
    const state = await client.threads.getState(thread.thread_id);
    expect(state.next).toEqual(["weather_graph"]);
    expect(state.tasks).toEqual([
      {
        id: expect.any(String),
        name: "weather_graph",
        path: ["__pregel_pull", "weather_graph"],
        error: null,
        interrupts: [],
        checkpoint: {
          checkpoint_ns: expect.stringMatching(/^weather_graph:/),
          thread_id: expect.any(String),
        },
        state: null,
        result: null,
      },
    ]);

    // edit the city in the subgraph state
    await client.threads.updateState(thread.thread_id, {
      values: { city: "LA" },
      checkpoint: state.tasks[0].checkpoint ?? undefined,
    });

    // get inner state after update
    const innerState = await client.threads.getState<{ city: string }>(
      thread.thread_id,
      state.tasks[0].checkpoint ?? undefined
    );

    expect(innerState.values.city).toBe("LA");
    expect(innerState.next).toEqual(["weather_node"]);
    expect(innerState.tasks).toEqual([
      {
        id: expect.any(String),
        name: "weather_node",
        path: ["__pregel_pull", "weather_node"],
        error: null,
        interrupts: [],
        checkpoint: null,
        state: null,
        result: null,
      },
    ]);

    // continue after interrupt
    chunks = await gatherIterator(
      client.runs.stream(thread.thread_id, graphId, {
        input: null,
      })
    );

    expect(chunks.filter((i) => i.event === "error")).toEqual([]);
    expect(chunks.at(-1)?.event).toBe("values");

    const continueMessages = findLast(chunks, (i) => i.event === "values")?.data
      .messages;

    expect(continueMessages.length).toBe(2);
    expect(continueMessages[0].content).toBe("SF");
    expect(continueMessages[1].content).toBe("It's sunny in LA!");

    // get the history for the root graph
    const history = await client.threads.getHistory<{
      messages: BaseMessageLike[];
    }>(thread.thread_id);
    expect(history.length).toBe(4);
    expect(history[0].next.length).toBe(0);
    expect(history[0].values.messages.length).toBe(2);
    expect(history[history.length - 1].next).toEqual(["__start__"]);

    // get inner history
    const innerHistory = await client.threads.getHistory<{
      messages: BaseMessageLike[];
      city: string;
    }>(thread.thread_id, {
      checkpoint: state.tasks[0].checkpoint ?? undefined,
    });
    expect(innerHistory.length).toBe(5);
    expect(innerHistory[0].next.length).toBe(0);
    expect(innerHistory[0].values.messages.length).toBe(2);
    expect(innerHistory[innerHistory.length - 1].next).toEqual(["__start__"]);
  });

  it.concurrent("interrupt inside node", async () => {
    const graphId = "agent";

    let thread = await client.threads.create();
    await gatherIterator(
      client.runs.stream(thread.thread_id, graphId, {
        input: {
          messages: [{ role: "human", content: "SF", id: "initial-message" }],
          interrupt: true,
        },
        config: globalConfig,
      })
    );

    const state = await client.threads.getState(thread.thread_id);
    expect(state.next).toEqual(["agent"]);
    expect(state.tasks).toMatchObject([
      {
        id: expect.any(String),
        name: "agent",
        path: ["__pregel_pull", "agent"],
        error: null,
        interrupts: [
          {
            id: expect.any(String),
            value: "i want to interrupt",
          },
        ],
        checkpoint: null,
        state: null,
        result: null,
      },
    ]);

    const stream = await gatherIterator(
      client.runs.stream(thread.thread_id, graphId, {
        command: { resume: "i want to resume" },
      })
    );

    expect(stream.at(-1)?.event).toBe("values");
    expect(stream.at(-1)?.data.messages.length).toBe(4);
  });
});

describe("command update state", () => {
  it("updates state via commands", async () => {
    const graphId = "agent";
    const thread = await client.threads.create();

    interface StateSchema {
      keyOne: string;
      keyTwo: string;
    }

    const input = { messages: [{ role: "human", content: "foo" }] };

    // dict-based updates
    await gatherIterator(
      client.runs.stream(thread.thread_id, graphId, {
        input,
        config: globalConfig,
      })
    );

    let stream = await gatherIterator(
      client.runs.stream(thread.thread_id, graphId, {
        command: { update: { keyOne: "value3", keyTwo: "value4" } },
        config: globalConfig,
      })
    );
    expect(stream.filter((chunk) => chunk.event === "error")).toEqual([]);

    let state = await client.threads.getState<StateSchema>(thread.thread_id);
    expect(state.values).toMatchObject({ keyOne: "value3", keyTwo: "value4" });
  });

  it("list-based updates", async () => {
    const thread = await client.threads.create();

    interface StateSchema {
      keyOne: string;
      keyTwo: string;
    }

    const input = { messages: [{ role: "human", content: "foo" }] };

    // list-based updates
    await gatherIterator(
      client.runs.stream(thread.thread_id, "agent", {
        input,
        config: globalConfig,
      })
    );

    const stream = await gatherIterator(
      client.runs.stream(thread.thread_id, "agent", {
        command: {
          update: [
            ["keyOne", "value1"],
            ["keyTwo", "value2"],
          ],
        },
        config: globalConfig,
      })
    );
    expect(stream.filter((chunk) => chunk.event === "error")).toEqual([]);

    const state = await client.threads.getState<StateSchema>(thread.thread_id);
    expect(state.values).toMatchObject({ keyOne: "value1", keyTwo: "value2" });
  });
});

it("stream debug checkpoint", async () => {
  const thread = await client.threads.create();
  const input = {
    messages: [{ role: "human", content: "What's the weather in SF?" }],
  };

  const runStream = client.runs.stream(thread.thread_id, "weather", {
    input,
    streamMode: "debug",
  });

  const stream = [];
  for await (const chunk of runStream) {
    if (chunk.event === "debug" && (chunk.data as any).type === "checkpoint") {
      stream.push((chunk.data as any).payload);
    }
  }

  const history = (
    await client.threads.getHistory(thread.thread_id, { limit: stream.length })
  ).reverse();

  expect(
    stream.map((i: any) => ({
      step: i.metadata?.step,
      checkpoint: i.checkpoint,
      parent_checkpoint: i.parent_checkpoint,
    }))
  ).toEqual(
    history.map((i) => ({
      step: i.metadata?.step,
      checkpoint: i.checkpoint,
      parent_checkpoint: i.parent_checkpoint,
    }))
  );
});

it("continue after interrupt must have checkpoint present", async () => {
  const graphId = "weather";
  const thread = await client.threads.create();

  const input = {
    messages: [{ role: "human", content: "What's weather in SF?" }],
  };

  let stream = await gatherIterator(
    client.runs.stream(thread.thread_id, graphId, {
      input,
      streamMode: "debug",
      interruptBefore: ["router_node"],
    })
  );

  const initialStream = stream
    .filter(
      (i) => i.event === "debug" && (i.data as any)?.type === "checkpoint"
    )
    .map((i) => (i.data as any)?.payload);

  const history = (await client.threads.getHistory(thread.thread_id)).reverse();
  const checkpoint = history[history.length - 1].checkpoint;

  // Continue the run from the checkpoint
  stream = await gatherIterator(
    client.runs.stream(thread.thread_id, graphId, {
      streamMode: "debug",
      checkpoint,
    })
  );

  const continueHistory = (
    await client.threads.getHistory(thread.thread_id)
  ).reverse();

  const continueStream = stream
    .filter((i) => i.event === "debug" && (i.data as any).type === "checkpoint")
    .map((i) => (i.data as any).payload);

  expect(
    [...initialStream, ...continueStream.slice(1)].map((i: any) => ({
      step: i.metadata?.step,
      checkpoint: i.checkpoint,
      parent_checkpoint: i.parent_checkpoint,
    }))
  ).toEqual(
    continueHistory.map((i) => ({
      step: i.metadata?.step,
      checkpoint: i.checkpoint,
      parent_checkpoint: i.parent_checkpoint,
    }))
  );
});

it("tasks / checkpoints stream mode", async () => {
  const thread = await client.threads.create();

  const stream = await gatherIterator(
    client.runs.stream(thread.thread_id, "agent", {
      input: { messages: [{ role: "human", content: "input" }] },
      streamMode: ["tasks", "checkpoints"],
      config: globalConfig,
    })
  );

  expect(stream).toMatchObject([
    {
      event: "metadata",
      data: { run_id: expect.any(String) },
    },
    {
      event: "checkpoints",
      data: {
        values: { messages: [] },
        metadata: { source: "input", step: -1 },
        next: ["__start__"],
      },
    },
    {
      event: "checkpoints",
      data: {
        values: { messages: [{ content: "input", type: "human" }] },
        metadata: { source: "loop", step: 0 },
        next: ["agent"],
      },
    },
    {
      event: "tasks",
      data: {
        name: "agent",
        input: { messages: [{ content: "input", type: "human" }] },
        triggers: ["branch:to:agent"],
        interrupts: [],
      },
    },
    {
      event: "tasks",
      data: {
        name: "agent",
        result: expect.arrayContaining([
          [
            "messages",
            [expect.objectContaining({ content: "begin", type: "ai" })],
          ],
        ]),
        interrupts: [],
      },
    },
    {
      event: "checkpoints",
      data: {
        values: {
          messages: [
            { content: "input", type: "human" },
            { content: "begin", type: "ai" },
          ],
        },
        metadata: { source: "loop", step: 1 },
        next: ["tool"],
      },
    },
    {
      event: "tasks",
      data: {
        name: "tool",
        input: {
          messages: [
            { content: "input", type: "human" },
            { content: "begin", type: "ai" },
          ],
        },
        triggers: ["branch:to:tool"],
        interrupts: [],
      },
    },
    {
      event: "tasks",
      data: {
        name: "tool",
        result: expect.arrayContaining([
          [
            "messages",
            [
              expect.objectContaining({
                content: "tool_call__begin",
                tool_call_id: "tool_call_id",
                type: "tool",
              }),
            ],
          ],
        ]),
        interrupts: [],
      },
    },
    {
      event: "checkpoints",
      data: {
        values: {
          messages: [
            { content: "input", type: "human" },
            { content: "begin", type: "ai" },
            {
              content: "tool_call__begin",
              tool_call_id: "tool_call_id",
              type: "tool",
            },
          ],
        },
        metadata: { source: "loop", step: 2 },
        next: ["agent"],
      },
    },
    {
      event: "tasks",
      data: {
        name: "agent",
        input: {
          messages: [
            { content: "input", type: "human" },
            { content: "begin", type: "ai" },
            {
              content: "tool_call__begin",
              tool_call_id: "tool_call_id",
              type: "tool",
            },
          ],
        },
        triggers: ["branch:to:agent"],
        interrupts: [],
      },
    },
    {
      event: "tasks",
      data: {
        name: "agent",
        result: expect.arrayContaining([
          [
            "messages",
            [expect.objectContaining({ content: "end", type: "ai" })],
          ],
        ]),
        interrupts: [],
      },
    },
    {
      event: "checkpoints",
      data: {
        values: {
          messages: [
            { content: "input", type: "human" },
            { content: "begin", type: "ai" },
            {
              content: "tool_call__begin",
              tool_call_id: "tool_call_id",
              type: "tool",
            },
            { content: "end", type: "ai" },
          ],
        },
        metadata: { source: "loop", step: 3 },
        next: [],
      },
    },
  ]);
});

describe("runtime API", () => {
  it("simple", async () => {
    const thread = await client.threads.create();
    const stream = await gatherIterator(
      client.runs.stream(thread.thread_id, "simple_runtime", {
        input: { messages: [{ role: "human", content: "input" }] },
        context: { model: "openai" },
      })
    );

    const values = stream
      .filter((i) => i.event === "values")
      .map((i) => i.data);

    expect(values).toMatchObject([{ model: "openai" }]);
  });
});

import { describe, expect, it, beforeEach, beforeAll } from "vitest";
import { Client } from "@langchain/langgraph-sdk";
import { findLast, gatherIterator } from "./utils.mts";
import {
  BaseMessageFields,
  BaseMessageLike,
  MessageType,
} from "@langchain/core/messages";
import postgres from "postgres";
import { randomUUID } from "crypto";

const API_URL = "http://localhost:9123";
const client = new Client({ apiUrl: API_URL });

// Passed to all invocation requests as the graph now requires this field to be present
// in `configurable` due to a new `SharedValue` field requiring it.
const globalConfig = {
  configurable: {
    user_id: "123",
  },
};

// TODO: this is not exported anywhere in JS
// we should support only the flattened one
type BaseMessage = {
  type: MessageType | "user" | "assistant" | "placeholder";
} & BaseMessageFields;

interface AgentState {
  messages: Array<BaseMessage>;
  sharedStateValue?: string | null;
}

const truncate = async (
  options:
    | {
        runs?: boolean;
        threads?: boolean;
        assistants?: boolean;
        store?: boolean;
        checkpoint?: boolean;
      }
    | "all"
) => {
  const flags =
    options === "all"
      ? {
          runs: true,
          threads: true,
          assistants: true,
          store: true,
          checkpoint: true,
        }
      : options;

  await fetch(`${API_URL}/internal/truncate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(flags),
  });
};

const IS_MEMORY = true;

beforeAll(() => truncate("all"));

describe.only("assistants", () => {
  it("create read update delete", async () => {
    const graphId = "agent";
    const config = { configurable: { model_name: "gpt" } };

    let res = await client.assistants.create({ graphId, config });
    expect(res).toMatchObject({ graph_id: graphId, config });

    const metadata = { name: "woof" };
    await client.assistants.update(res.assistant_id, { graphId, metadata });

    res = await client.assistants.get(res.assistant_id);
    expect(res).toMatchObject({ graph_id: graphId, config, metadata });

    await client.assistants.delete(res.assistant_id);
    expect(() => client.assistants.get(res.assistant_id)).rejects.toThrow(
      "HTTP 404: Assistant not found"
    );
  });

  it.skip("schemas", async () => {
    const graphId = "agent";
    const config = { configurable: { model: "openai" } };

    let res = await client.assistants.create({ graphId, config });
    expect(res).toMatchObject({ graph_id: graphId, config });

    res = await client.assistants.get(res.assistant_id);
    expect(res).toMatchObject({ graph_id: graphId, config });

    const graph = await client.assistants.getGraph(res.assistant_id);
    expect(graph).toMatchObject({
      nodes: expect.arrayContaining([
        expect.objectContaining({ id: "__start__", type: "schema" }),
        expect.objectContaining({
          id: "agent",
          type: "runnable",
          data: expect.objectContaining({ name: "agent" }),
        }),
        expect.objectContaining({
          id: "tool",
          type: "runnable",
          data: expect.objectContaining({ name: "tool" }),
        }),
        expect.objectContaining({ id: "__end__", type: "schema" }),
      ]),
      edges: expect.arrayContaining([
        expect.objectContaining({ source: "__start__", target: "agent" }),
        expect.objectContaining({ source: "tool", target: "agent" }),
        expect.objectContaining({
          source: "agent",
          target: "tool",
          conditional: true,
        }),
        expect.objectContaining({ source: "agent", target: "__end__" }),
      ]),
    });

    const schemas = await client.assistants.getSchemas(res.assistant_id);
    expect(schemas.input_schema).not.toBe(null);
    expect(schemas.output_schema).not.toBe(null);
    expect(schemas.config_schema).toMatchObject({
      type: "object",
      properties: { model_name: { type: "string" } },
      $schema: "http://json-schema.org/draft-07/schema#",
    });

    expect(schemas.state_schema).toMatchObject({
      type: "object",
      properties: {
        messages: {
          type: "array",
          items: { $ref: "#/definitions/BaseMessage" },
        },
      },
      definitions: {
        BaseMessage: {
          oneOf: [
            { $ref: "#/definitions/BaseMessageChunk" },
            { $ref: "#/definitions/ToolMessage" },
            { $ref: "#/definitions/AIMessage" },
            { $ref: "#/definitions/ChatMessage" },
            { $ref: "#/definitions/FunctionMessage" },
            { $ref: "#/definitions/HumanMessage" },
            { $ref: "#/definitions/SystemMessage" },
            { $ref: "#/definitions/RemoveMessage" },
          ],
        },
      },
      $schema: "http://json-schema.org/draft-07/schema#",
    });

    await client.assistants.delete(res.assistant_id);
    expect(() => client.assistants.get(res.assistant_id)).rejects.toThrow(
      "HTTP 404: Assistant not found"
    );
  });

  it("list assistants", async () => {
    let search = await client.assistants.search();

    // Greater than or equal because the vitest retries can cause multiple assistants to be created
    expect(search.length).toBeGreaterThanOrEqual(1);

    const graphid = "agent";
    const create = await client.assistants.create({ graphId: "agent" });

    search = await client.assistants.search();
    expect(search.length).toBeGreaterThanOrEqual(2);

    search = await client.assistants.search({ graphId: graphid });
    expect(search.length).toBeGreaterThanOrEqual(2);
    expect(search.every((i) => i.graph_id === graphid)).toBe(true);

    search = await client.assistants.search({
      metadata: { created_by: "system" },
    });
    expect(search.length).toBeGreaterThanOrEqual(1);
    expect(search.every((i) => i.assistant_id !== create.assistant_id)).toBe(
      true
    );
  });

  it("config from env", async () => {
    let search = await client.assistants.search({
      graphId: "agent",
      metadata: { created_by: "system" },
    });

    expect(search.length).toBe(1);
    expect(search[0].config).toMatchObject({
      configurable: { model_name: "openai" },
    });
  });
});

describe.only("threads crud", () => {
  beforeEach(() => truncate({ threads: true }));

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
  });
});

describe("threads copy", () => {
  it.concurrent("copy", async () => {
    const assistantId = "agent";
    const thread = await client.threads.create();
    const input = { messages: [{ type: "human", content: "foo" }] };
    await client.runs.wait(thread.thread_id, assistantId, {
      input,
      config: globalConfig,
    });

    const threadState = await client.threads.getState(thread.thread_id);

    const copiedThread = await client.threads.copy(thread.thread_id);
    const copiedThreadState = await client.threads.getState(
      copiedThread.thread_id
    );

    // check copied thread state matches expected output
    const expectedThreadMetadata = {
      ...threadState.metadata,
      thread_id: copiedThread.thread_id,
    };
    const expectedThreadState = {
      ...threadState,
      checkpoint: {
        ...threadState.checkpoint,
        thread_id: copiedThread.thread_id,
      },
      parent_checkpoint: {
        ...threadState.parent_checkpoint,
        thread_id: copiedThread.thread_id,
      },
      metadata: expectedThreadMetadata,
      checkpoint_id: copiedThreadState.checkpoint.checkpoint_id,
      parent_checkpoint_id: copiedThreadState.parent_checkpoint?.checkpoint_id,
    };
    expect(copiedThreadState).toEqual(expectedThreadState);

    if (IS_MEMORY) {
    } else {
      const sql = postgres(
        process.env.POSTGRES_URI ??
          "postgres://postgres:postgres@127.0.0.1:5433/postgres?sslmode=disable"
      );

      // check checkpoints in DB
      const existingCheckpoints = await sql`
        SELECT * FROM checkpoints WHERE thread_id = ${thread.thread_id}
      `;
      const copiedCheckpoints = await sql`
        SELECT * FROM checkpoints WHERE thread_id = ${copiedThread.thread_id}
      `;

      expect(existingCheckpoints.length).toBe(copiedCheckpoints.length);
      for (let i = 0; i < existingCheckpoints.length; i++) {
        const existing = existingCheckpoints[i];
        const copied = copiedCheckpoints[i];
        delete existing.thread_id;
        delete existing.metadata.thread_id;
        delete copied.thread_id;
        delete copied.metadata.thread_id;
        expect(existing).toEqual(copied);
      }

      // check checkpoint blobs in DB
      const existingCheckpointBlobs = await sql`
        SELECT * FROM checkpoint_blobs WHERE thread_id = ${thread.thread_id} ORDER BY channel, version
      `;
      const copiedCheckpointBlobs = await sql`
        SELECT * FROM checkpoint_blobs WHERE thread_id = ${copiedThread.thread_id} ORDER BY channel, version
      `;

      expect(existingCheckpointBlobs.length).toBe(copiedCheckpointBlobs.length);
      for (let i = 0; i < existingCheckpointBlobs.length; i++) {
        const existing = existingCheckpointBlobs[i];
        const copied = copiedCheckpointBlobs[i];
        delete existing.thread_id;
        delete copied.thread_id;
        expect(existing).toEqual(copied);
      }
    }
  });

  it.concurrent("copy runs", async () => {
    const assistantId = "agent";
    const thread = await client.threads.create();

    const input = { messages: [{ type: "human", content: "foo" }] };
    await client.runs.wait(thread.thread_id, assistantId, {
      input,
      config: globalConfig,
    });
    const originalThreadState = await client.threads.getState(thread.thread_id);

    const copiedThread = await client.threads.copy(thread.thread_id);
    const newInput = { messages: [{ type: "human", content: "bar" }] };
    await client.runs.wait(copiedThread.thread_id, assistantId, {
      input: newInput,
      config: globalConfig,
    });

    // test that copied thread has original as well as new values
    const copiedThreadState = await client.threads.getState<AgentState>(
      copiedThread.thread_id
    );

    const copiedThreadStateMessages = copiedThreadState.values.messages.map(
      (m) => m.content
    );
    expect(copiedThreadStateMessages).toEqual([
      // original messages
      "foo",
      "begin",
      "tool_call__begin",
      "end",
      // new messages
      "bar",
      "begin",
      "tool_call__begin",
      "end",
    ]);

    // test that the new run on the copied thread doesn't affect the original one
    const currentOriginalThreadState = await client.threads.getState(
      thread.thread_id
    );
    expect(currentOriginalThreadState).toEqual(originalThreadState);
  });

  it.concurrent("get thread history", async () => {
    const assistant = await client.assistants.create({ graphId: "agent" });
    const thread = await client.threads.create();
    const input = { messages: [{ type: "human", content: "foo" }] };

    const emptyHistory = await client.threads.getHistory(thread.thread_id);
    expect(emptyHistory.length).toBe(0);

    await client.runs.wait(thread.thread_id, assistant.assistant_id, {
      input,
      config: globalConfig,
    });

    const history = await client.threads.getHistory<AgentState>(
      thread.thread_id
    );
    expect(history.length).toBe(5);
    expect(history[0].values.messages.length).toBe(4);
    expect(history[0].next.length).toBe(0);
    expect(history.at(-1)?.next).toEqual(["__start__"]);

    const runMetadata = { run_metadata: "run_metadata" };
    const inputBar = { messages: [{ type: "human", content: "bar" }] };
    await client.runs.wait(thread.thread_id, assistant.assistant_id, {
      input: inputBar,
      metadata: runMetadata,
      config: globalConfig,
    });

    const fullHistory = await client.threads.getHistory<AgentState>(
      thread.thread_id
    );
    const filteredHistory = await client.threads.getHistory<AgentState>(
      thread.thread_id,
      { metadata: runMetadata }
    );

    expect(fullHistory.length).toBe(10);
    expect(fullHistory.at(-1)?.values.messages.length).toBe(0);

    expect(filteredHistory.length).toBe(5);
    expect(filteredHistory.at(-1)?.values.messages.length).toBe(4);
  });

  it.concurrent("copy update", async () => {
    const assistantId = "agent";
    const thread = await client.threads.create();
    const input = {
      messages: [{ type: "human", content: "foo", id: "initial-message" }],
    };
    await client.runs.wait(thread.thread_id, assistantId, {
      input,
      config: globalConfig,
    });

    const originalState = await client.threads.getState(thread.thread_id);
    const copyThread = await client.threads.copy(thread.thread_id);

    // update state on a copied thread
    const update = { type: "human", content: "bar", id: "initial-message" };
    await client.threads.updateState(copyThread.thread_id, {
      values: { messages: [update] },
    });

    const copiedThreadState = await client.threads.getState<AgentState>(
      copyThread.thread_id
    );
    expect(copiedThreadState.values.messages[0].content).toBe("bar");

    // test that updating the copied thread doesn't affect the original one
    const currentOriginalThreadState = await client.threads.getState(
      thread.thread_id
    );
    expect(currentOriginalThreadState).toEqual(originalState);
  });
});

describe("runs", () => {
  beforeAll(async () => truncate({ store: true, threads: true }));

  it.concurrent("list runs", async () => {
    const assistant = await client.assistants.create({ graphId: "agent" });
    const thread = await client.threads.create();
    await client.runs.wait(thread.thread_id, assistant.assistant_id, {
      input: { messages: [{ type: "human", content: "foo" }] },
      config: globalConfig,
    });

    const pendingRun = await client.runs.create(
      thread.thread_id,
      assistant.assistant_id,
      {
        input: { messages: [{ type: "human", content: "bar" }] },
        config: globalConfig,
      }
    );

    let runs = await client.runs.list(thread.thread_id);
    expect(runs.length).toBe(2);

    runs = await client.runs.list(thread.thread_id, { status: "pending" });
    expect(runs.length).toBe(1);

    await client.runs.cancel(thread.thread_id, pendingRun.run_id);

    runs = await client.runs.list(thread.thread_id, { status: "interrupted" });
    expect(runs.length).toBe(1);
  });

  it.concurrent("stream values", async () => {
    const assistant = await client.assistants.create({ graphId: "agent" });
    const thread = await client.threads.create();
    const input = {
      messages: [{ type: "human", content: "foo", id: "initial-message" }],
    };
    const stream = client.runs.stream(
      thread.thread_id,
      assistant.assistant_id,
      { input, streamMode: "values", config: globalConfig }
    );

    let runId: string | null = null;
    let previousMessageIds = [];
    const seenEventTypes = new Set();

    let chunk: any;
    for await (chunk of stream) {
      seenEventTypes.add(chunk.event);

      if (chunk.event === "metadata") {
        runId = chunk.data.run_id;
      }

      if (chunk.event === "values") {
        const messageIds = chunk.data.messages.map((message) => message.id);
        expect(messageIds.slice(0, -1)).toEqual(previousMessageIds);
        previousMessageIds = messageIds;
      }
    }

    expect(chunk.event).toBe("values");
    expect(seenEventTypes).toEqual(new Set(["metadata", "values"]));

    expect(runId).not.toBeNull();
    const run = await client.runs.get(thread.thread_id, runId as string);
    expect(run.status).toBe("success");

    if (IS_MEMORY) {
    } else {
      const sql = postgres(
        process.env.POSTGRES_URI ??
          "postgres://postgres:postgres@127.0.0.1:5433/postgres?sslmode=disable"
      );

      let cur = await sql`SELECT * FROM checkpoints WHERE run_id is null`;

      expect(cur).toHaveLength(0);

      cur = await sql`SELECT * FROM checkpoints WHERE run_id = ${run.run_id}`;
      expect(cur.length).toBeGreaterThan(1);
    }
  });

  it.concurrent("wait error", async () => {
    const assistant = await client.assistants.create({ graphId: "agent" });
    const thread = await client.threads.create();
    const input = {
      messages: [{ type: "human", content: "foo", id: "initial-message" }],
    };

    await expect(
      client.runs.wait(thread.thread_id, assistant.assistant_id, {
        input,
        config: { ...globalConfig, recursion_limit: 1 },
      })
    ).rejects.toThrowError(/GraphRecursionError/);
    const threadUpdated = await client.threads.get(thread.thread_id);
    expect(threadUpdated.status).toBe("error");
  });

  it.concurrent("wait", async () => {
    const assistant = await client.assistants.create({ graphId: "agent" });
    const thread = await client.threads.create();
    const input = {
      messages: [{ type: "human", content: "foo", id: "initial-message" }],
    };
    const values = await client.runs.wait(
      thread.thread_id,
      assistant.assistant_id,
      { input, config: globalConfig }
    );

    expect(Array.isArray((values as any).messages)).toBe(true);
    const threadUpdated = await client.threads.get(thread.thread_id);
    expect(threadUpdated.status).toBe("idle");
  });

  it.concurrent("stream updates", async () => {
    const assistant = await client.assistants.create({ graphId: "agent" });
    const thread = await client.threads.create();
    const input = {
      messages: [{ type: "human", content: "foo", id: "initial-message" }],
    };
    const stream = client.runs.stream(
      thread.thread_id,
      assistant.assistant_id,
      { input, streamMode: "updates", config: globalConfig }
    );

    let runId: string | null = null;
    const seenEventTypes = new Set();
    const seenNodes: string[] = [];

    let chunk: any;
    for await (chunk of stream) {
      seenEventTypes.add(chunk.event);

      if (chunk.event === "metadata") {
        runId = chunk.data.run_id;
      }

      if (chunk.event === "updates") {
        const node = Object.keys(chunk.data)[0];
        seenNodes.push(node);
      }
    }

    expect(seenNodes).toEqual(["agent", "tool", "agent"]);

    expect(chunk.event).toBe("updates");
    expect(seenEventTypes).toEqual(new Set(["metadata", "updates"]));

    expect(runId).not.toBeNull();
    const run = await client.runs.get(thread.thread_id, runId as string);
    expect(run.status).toBe("success");
  });

  it.concurrent("stream events", async () => {
    const assistant = await client.assistants.create({ graphId: "agent" });
    const thread = await client.threads.create();
    const input = {
      messages: [{ type: "human", content: "foo", id: "initial-message" }],
    };
    const stream = client.runs.stream(
      thread.thread_id,
      assistant.assistant_id,
      { input, streamMode: "events", config: globalConfig }
    );

    const events = await gatherIterator(stream);
    expect(new Set(events.map((i) => i.event))).toEqual(
      new Set(["metadata", "events"])
    );

    expect(
      new Set(
        events.filter((i) => i.event === "events").map((i) => i.data.event)
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
    const assistant = await client.assistants.create({ graphId: "agent" });
    const thread = await client.threads.create();
    const input = {
      messages: [{ type: "human", content: "foo", id: "initial-message" }],
    };
    const stream = client.runs.stream(
      thread.thread_id,
      assistant.assistant_id,
      { input, streamMode: "messages", config: globalConfig }
    );

    let runId: string | null = null;
    const seenEventTypes = new Set();
    const messageIdToContent: Record<string, string> = {};
    let lastMessage: any = null;

    let chunk: any;
    for await (chunk of stream) {
      seenEventTypes.add(chunk.event);

      if (chunk.event === "metadata") {
        runId = chunk.data.run_id;
      }

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

    expect(runId).not.toBeNull();
    const run = await client.runs.get(thread.thread_id, runId as string);
    expect(run.status).toBe("success");
  });

  it.concurrent("stream mixed modes", async () => {
    const assistant = await client.assistants.create({ graphId: "agent" });
    const thread = await client.threads.create();
    const input = {
      messages: [{ type: "human", content: "foo", id: "initial-message" }],
    };
    const stream = await client.runs.stream(
      thread.thread_id,
      assistant.assistant_id,
      { input, streamMode: ["messages", "values"], config: globalConfig }
    );

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

    const run = await client.runs.get(thread.thread_id, runId);
    expect(run.status).toBe("success");
  });

  it.concurrent(
    "human in the loop - no modification",
    { retry: 0 },
    async () => {
      const assistant = await client.assistants.create({ graphId: "agent" });
      const thread = await client.threads.create();
      const input = {
        messages: [{ type: "human", content: "foo", id: "initial-message" }],
      };
      let messages: BaseMessage[] = [];

      // (1) interrupt and then continue running, no modification
      // run until the interrupt
      let chunks = await gatherIterator(
        client.runs.stream(thread.thread_id, assistant.assistant_id, {
          input,
          interruptBefore: ["tool"],
          config: globalConfig,
        })
      );

      expect(chunks.filter((i) => i.event === "error").length).toBe(0);
      messages = findLast(chunks, (i) => i.event === "values")?.data.messages;

      const threadAfterInterrupt = await client.threads.get(thread.thread_id);
      expect(threadAfterInterrupt.status).toBe("interrupted");

      expect(messages.at(-1)).not.toBeNull();
      expect(messages.at(-1)?.content).toBe("begin");

      const state = await client.threads.getState(thread.thread_id);
      expect(state.next).toEqual(["tool"]);

      // continue after interrupt
      chunks = await gatherIterator(
        client.runs.stream(thread.thread_id, assistant.assistant_id, {
          input: null,
          config: globalConfig,
        })
      );

      expect(chunks.filter((i) => i.event === "error").length).toBe(0);
      messages = findLast(chunks, (i) => i.event === "values")?.data.messages;

      expect(messages.length).toBe(4);
      expect(messages[2].content).toBe("tool_call__begin");
      expect(messages.at(-1)?.content).toBe("end");

      const threadAfterContinue = await client.threads.get(thread.thread_id);
      expect(threadAfterContinue.status).toBe("idle");
    }
  );

  it.concurrent("human in the loop - modification", async () => {
    // (2) interrupt, modify the message and then continue running
    const assistant = await client.assistants.create({ graphId: "agent" });
    const thread = await client.threads.create();
    const input = {
      messages: [{ type: "human", content: "foo", id: "initial-message" }],
    };
    let messages: BaseMessage[] = [];

    // run until the interrupt
    let chunks = await gatherIterator(
      client.runs.stream(thread.thread_id, assistant.assistant_id, {
        input,
        interruptBefore: ["tool"],
        config: globalConfig,
      })
    );

    expect(chunks.filter((i) => i.event === "error").length).toBe(0);

    // edit the last message
    const lastMessage = findLast(
      chunks,
      (i) => i.event === "values"
    )?.data.messages.at(-1);
    lastMessage.content = "modified";

    // update state
    await client.threads.updateState<AgentState>(thread.thread_id, {
      values: { messages: [lastMessage] },
    });
    await client.threads.update(thread.thread_id, {
      metadata: { modified: true },
    });

    const modifiedThread = await client.threads.get(thread.thread_id);
    expect(modifiedThread.status).toBe("interrupted");
    expect(modifiedThread.metadata?.modified).toBe(true);

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
      client.runs.stream(thread.thread_id, assistant.assistant_id, {
        input: null,
        config: globalConfig,
      })
    );

    const threadAfterContinue = await client.threads.get(thread.thread_id);
    expect(threadAfterContinue.status).toBe("idle");

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

  it.concurrent("interrupt before", async () => {
    const assistant = await client.assistants.create({ graphId: "agent" });
    let thread = await client.threads.create();
    const input = {
      messages: [{ type: "human", content: "foo", id: "initial-message" }],
    };

    await client.runs.wait(thread.thread_id, assistant.assistant_id, {
      input,
      interruptBefore: ["agent"],
      config: globalConfig,
    });

    thread = await client.threads.get(thread.thread_id);
    expect(thread.status).toBe("interrupted");
  });
});

describe("shared state", () => {
  beforeEach(() => truncate({ store: true }));

  it("should share state between runs with the same thread ID", async () => {
    const assistant = await client.assistants.create({ graphId: "agent" });
    const thread = await client.threads.create();

    const input = {
      messages: [
        { type: "human", content: "should_end", id: "initial-message" },
      ],
    };
    const config = { configurable: { user_id: "start_user_id" } };

    // First run
    const res1 = (await client.runs.wait(
      thread.thread_id,
      assistant.assistant_id,
      { input, config }
    )) as Awaited<Record<string, any>>;
    expect(res1.sharedStateValue).toBe(null);

    // Second run with the same thread ID & config
    const res2 = (await client.runs.wait(
      thread.thread_id,
      assistant.assistant_id,
      { input, config }
    )) as Awaited<Record<string, any>>;
    expect(res2.sharedStateValue).toBe(config.configurable.user_id);
  });

  it("should not share state between runs with different thread IDs", async () => {
    const assistant = await client.assistants.create({ graphId: "agent" });
    const thread = await client.threads.create();

    const input = {
      messages: [{ type: "human", content: "foo", id: "initial-message" }],
    };

    // Run with the default `globalConfig`
    const config1 = { configurable: { user_id: "start_user_id" } };
    const res1 = (await client.runs.wait(
      thread.thread_id,
      assistant.assistant_id,
      { input, config: config1 }
    )) as Awaited<Record<string, any>>;

    // Run with the same thread id but a new config
    const config2 = { configurable: { user_id: "new_user_id" } };
    const res2 = (await client.runs.wait(
      thread.thread_id,
      assistant.assistant_id,
      { input, config: config2 }
    )) as Awaited<Record<string, any>>;

    expect(res1.sharedStateValue).toBe(config1.configurable.user_id);
    // Null on first iteration since the shared value is set in the second iteration
    expect(res2.sharedStateValue).toBe(config2.configurable.user_id);
    expect(res1.sharedStateValue).not.toBe(res2.sharedStateValue);
  });

  it("should be able to set and return data from store in config", async () => {
    const assistant = await client.assistants.create({ graphId: "agent" });
    const thread = await client.threads.create();

    const input = {
      messages: [{ type: "human", content: "foo", id: "initial-message" }],
    };
    const config = {
      configurable: {
        user_id: "start_user_id",
      },
    };

    // Run with the default `globalConfig`
    const res1 = (await client.runs.wait(
      thread.thread_id,
      assistant.assistant_id,
      { input, config }
    )) as Awaited<Record<string, any>>;
    expect(res1.sharedStateFromStoreConfig).toBeDefined();
    expect(res1.sharedStateFromStoreConfig.id).toBeDefined();
    expect(res1.sharedStateFromStoreConfig.id).toBe(
      config.configurable.user_id
    );
  });

  it("Should be able to use the store client to fetch values", async () => {
    const assistant = await client.assistants.create({ graphId: "agent" });
    const thread = await client.threads.create();

    const input = {
      messages: [{ type: "human", content: "foo", id: "initial-message" }],
    };
    const config = {
      configurable: {
        user_id: "start_user_id",
      },
    };

    // For shared state
    const namespace = ["sharedState", "data"];
    const key = "user_id";

    // Run with the default `globalConfig`
    const res1 = (await client.runs.wait(
      thread.thread_id,
      assistant.assistant_id,
      { input, config }
    )) as Awaited<Record<string, any>>;
    expect(res1.sharedStateFromStoreConfig).toBeDefined();
    expect(res1.sharedStateFromStoreConfig.id).toBeDefined();
    expect(res1.sharedStateFromStoreConfig.id).toBe(
      config.configurable.user_id
    );

    // Fetch data from store client
    const storeRes = await client.store.getItem(namespace, key);
    expect(storeRes).toBeDefined();
    expect(storeRes?.value).toBeDefined();
    expect(storeRes?.value).toEqual({ id: config.configurable.user_id });
  });
});

describe("StoreClient", () => {
  beforeEach(async () => truncate({ store: true }));

  it("Should be able to use the store client methods", async () => {
    const assistant = await client.assistants.create({ graphId: "agent" });
    const thread = await client.threads.create();

    const input = {
      messages: [
        {
          type: "human",
          content: "___check_state_value",
          id: "initial-message",
        },
      ],
    };
    const config = {
      configurable: {
        user_id: "start_user_id",
      },
    };

    // For shared state
    const namespace = ["inputtedState", "data"];
    const key = "my_key";

    // Set the value
    await client.store.putItem(namespace, key, { isTrue: true });

    // Invoke the graph and ensure the value is set
    // When the graph is invoked with this input, it will route to
    // a special node that throws an error if the value is not set.
    await client.runs.wait(thread.thread_id, assistant.assistant_id, {
      input,
      config,
    });

    // Verify it can be fetched
    const storeRes = await client.store.getItem(namespace, key);
    expect(storeRes).toBeDefined();
    expect(storeRes?.value).toBeDefined();
    expect(storeRes?.value).toEqual({ isTrue: true });

    await client.store.deleteItem(namespace, key);
    const storeResAfterDelete = await client.store.getItem(namespace, key);
    expect(storeResAfterDelete).toBe(null);
  });

  it("Can put, search, list, get and delete", async () => {
    const namespace = ["allMethods", "data"];
    const key = randomUUID();
    const value = { foo: "bar" };

    // Try searching when no values are present.
    const searchRes = await client.store.searchItems(namespace);
    expect(searchRes.items).toBeDefined();
    expect(searchRes.items.length).toBe(0);

    // Try listing when no values are present.
    const listRes = await client.store.listNamespaces();
    expect(listRes.namespaces).toBeDefined();
    expect(listRes.namespaces.length).toBe(0);

    // Put an item
    await client.store.putItem(namespace, key, value);

    // Get the item
    const getRes = await client.store.getItem(namespace, key);
    expect(getRes).toBeDefined();
    expect(getRes?.value).toEqual(value);

    const searchResAfterPut = await client.store.searchItems(namespace);
    expect(searchResAfterPut.items).toBeDefined();
    expect(searchResAfterPut.items.length).toBe(1);
    expect(searchResAfterPut.items[0].key).toBe(key);
    expect(searchResAfterPut.items[0].value).toEqual(value);
    expect(searchResAfterPut.items[0].createdAt).toBeDefined();
    expect(searchResAfterPut.items[0].updatedAt).toBeDefined();
    expect(
      new Date(searchResAfterPut.items[0].createdAt).getTime()
    ).toBeLessThanOrEqual(Date.now());
    expect(
      new Date(searchResAfterPut.items[0].updatedAt).getTime()
    ).toBeLessThanOrEqual(Date.now());

    const updatedValue = { foo: "baz" };
    await client.store.putItem(namespace, key, updatedValue);

    const getResAfterUpdate = await client.store.getItem(namespace, key);
    expect(getResAfterUpdate).toBeDefined();
    expect(getResAfterUpdate?.value).toEqual(updatedValue);

    const searchResAfterUpdate = await client.store.searchItems(namespace);
    expect(searchResAfterUpdate.items).toBeDefined();
    expect(searchResAfterUpdate.items.length).toBe(1);
    expect(searchResAfterUpdate.items[0].key).toBe(key);
    expect(searchResAfterUpdate.items[0].value).toEqual(updatedValue);

    expect(
      new Date(searchResAfterUpdate.items[0].updatedAt).getTime()
    ).toBeGreaterThan(new Date(searchResAfterPut.items[0].updatedAt).getTime());

    const listResAfterPut = await client.store.listNamespaces();
    expect(listResAfterPut.namespaces).toBeDefined();
    expect(listResAfterPut.namespaces.length).toBe(1);
    expect(listResAfterPut.namespaces[0]).toEqual(namespace);

    await client.store.deleteItem(namespace, key);

    const getResAfterDelete = await client.store.getItem(namespace, key);
    expect(getResAfterDelete).toBeNull();

    const searchResAfterDelete = await client.store.searchItems(namespace);
    expect(searchResAfterDelete.items).toBeDefined();
    expect(searchResAfterDelete.items.length).toBe(0);
  });
});

describe("subgraphs", () => {
  it.concurrent("get subgraphs", async () => {
    const assistant = await client.assistants.create({ graphId: "nested" });

    expect(
      Object.keys(await client.assistants.getSubgraphs(assistant.assistant_id))
    ).toEqual(["gp_two"]);

    const subgraphs = await client.assistants.getSubgraphs(
      assistant.assistant_id,
      { recurse: true }
    );

    expect(Object.keys(subgraphs)).toEqual(["gp_two", "gp_two|p_two"]);
    expect(subgraphs).toMatchObject({
      gp_two: {
        state: {
          type: "object",
          properties: {
            parent: {
              type: "string",
              enum: ["parent_one", "parent_two"],
            },
            messages: { type: "array" },
          },
        },
      },
      "gp_two|p_two": {
        state: {
          type: "object",
          properties: {
            child: {
              type: "string",
              enum: ["child_one", "child_two"],
            },
            messages: { type: "array" },
          },
        },
      },
    });
  });

  // (1) interrupt and then continue running, no modification
  it.concurrent("human in the loop - no modification", async () => {
    const assistant = await client.assistants.create({ graphId: "weather" });

    const thread = await client.threads.create();
    const input = {
      messages: [{ role: "human", content: "SF", id: "initial-message" }],
    };

    // run until the interrupt
    let lastMessageBeforeInterrupt: { content?: string } | null = null;
    let chunks = await gatherIterator(
      client.runs.stream(thread.thread_id, assistant.assistant_id, {
        input,
        interruptBefore: ["tool"],
      })
    );

    for (const chunk of chunks) {
      if (chunk.event === "values") {
        lastMessageBeforeInterrupt =
          chunk.data.messages[chunk.data.messages.length - 1];
      }

      if (chunk.event === "error") {
        throw new Error(chunk.data);
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
          checkpoint_id: expect.any(String),
          parent_checkpoint_id: expect.any(String),
        },
      },
    ]);

    const threadAfterInterrupt = await client.threads.get(thread.thread_id);
    expect(threadAfterInterrupt.status).toBe("interrupted");

    // continue after interrupt
    chunks = await gatherIterator(
      client.runs.stream(thread.thread_id, assistant.assistant_id, {
        input: null,
        streamMode: ["values", "updates"],
        streamSubgraphs: true,
      })
    );

    expect(chunks.filter((i) => i.event === "error")).toEqual([]);
    expect(chunks.at(-1)?.event).toBe("values");

    const continueMessages = findLast(chunks, (i) => i.event === "values")?.data
      .messages;

    expect(continueMessages.length).toBe(2);
    expect(continueMessages[0].content).toBe("SF");
    expect(continueMessages[1].content).toBe("It's sunny in San Francisco!");
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

    const threadAfterContinue = await client.threads.get(thread.thread_id);
    expect(threadAfterContinue.status).toBe("idle");
  });

  // (2) interrupt, modify the message and then continue running
  it.concurrent("human in the loop - modification", async () => {
    const assistant = await client.assistants.create({ graphId: "weather" });
    const thread = await client.threads.create();
    const input = {
      messages: [{ role: "human", content: "SF", id: "initial-message" }],
    };

    // run until the interrupt (same as before)
    let chunks = await gatherIterator(
      client.runs.stream(thread.thread_id, assistant.assistant_id, { input })
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
      client.runs.stream(thread.thread_id, assistant.assistant_id, {
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
    const assistant = await client.assistants.create({ graphId: "agent" });

    let thread = await client.threads.create();
    await client.runs.wait(thread.thread_id, assistant.assistant_id, {
      input: {
        messages: [{ role: "human", content: "SF", id: "initial-message" }],
        interrupt: true,
      },
      config: globalConfig,
    });

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
            value: "i want to interrupt",
            when: "during",
            resumable: true,
            ns: [expect.stringMatching(/^agent:/)],
          },
        ],
        checkpoint: null,
        state: null,
        result: null,
      },
    ]);

    thread = await client.threads.get(thread.thread_id);
    expect(thread.status).toBe("interrupted");
    expect(thread.interrupts).toMatchObject({
      [state.tasks[0].id]: [
        {
          value: "i want to interrupt",
          when: "during",
          resumable: true,
          ns: [expect.stringMatching(/^agent:/)],
        },
      ],
    });

    const stream = await gatherIterator(
      client.runs.stream(thread.thread_id, assistant.assistant_id, {
        command: { resume: "i want to resume" },
      })
    );

    expect(stream.at(-1)?.event).toBe("values");
    expect(stream.at(-1)?.data.messages.length).toBe(4);
  });
});

describe("errors", () => {
  it.concurrent("stream", async () => {
    const assistant = await client.assistants.create({ graphId: "error" });
    const thread = await client.threads.create();

    const stream = await gatherIterator(
      client.runs.stream(thread.thread_id, assistant.assistant_id, {
        input: { messages: [] },
        streamMode: ["debug", "events"],
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

  it.concurrent("create + join", async () => {
    const assistant = await client.assistants.create({ graphId: "error" });
    const thread = await client.threads.create();

    const run = await client.runs.create(
      thread.thread_id,
      assistant.assistant_id,
      { input: { messages: [] } }
    );

    await client.runs.join(thread.thread_id, run.run_id);
    const runState = await client.runs.get(thread.thread_id, run.run_id);
    expect(runState.status).toEqual("error");
  });

  it.concurrent("create + stream join", async () => {
    const assistant = await client.assistants.create({ graphId: "error" });
    const thread = await client.threads.create();

    const run = await client.runs.create(
      thread.thread_id,
      assistant.assistant_id,
      { input: { messages: [] } }
    );

    const stream = await gatherIterator(
      client.runs.joinStream(thread.thread_id, run.run_id)
    );

    expect(stream.at(-1)).toMatchObject({
      event: "error",
      data: {
        error: "CustomError",
        message: "Boo!",
      },
    });

    const runState = await client.runs.get(thread.thread_id, run.run_id);
    expect(runState.status).toEqual("error");
  });
});

describe("long running tasks", () => {
  it.concurrent.for([1000, 8000, 12000])(
    "long running task with %dms delay",
    { timeout: 15_000 },
    async (delay) => {
      const assistant = await client.assistants.create({ graphId: "delay" });
      const thread = await client.threads.create();

      const run = await client.runs.create(
        thread.thread_id,
        assistant.assistant_id,
        {
          input: { messages: [], delay },
          config: globalConfig,
        }
      );

      await client.runs.join(thread.thread_id, run.run_id);

      const runState = await client.runs.get(thread.thread_id, run.run_id);
      expect(runState.status).toEqual("success");

      const runResult = await client.threads.getState<{
        messages: BaseMessageLike[];
        delay: number;
      }>(thread.thread_id);

      expect(runResult.values.messages).toMatchObject([
        { content: `finished after ${delay}ms` },
      ]);
    }
  );
});

// Not implemented in JS yet
describe.skip("command update state", () => {
  it("updates state via commands", async () => {
    const assistant = await client.assistants.create({ graphId: "agent" });
    const thread = await client.threads.create();

    const input = { messages: [{ role: "human", content: "foo" }] };

    // dict-based updates
    await client.runs.wait(thread.thread_id, assistant.assistant_id, {
      input,
      config: globalConfig,
    });
    let stream = await gatherIterator(
      client.runs.stream(thread.thread_id, assistant.assistant_id, {
        command: { update: { keyOne: "value3", keyTwo: "value4" } },
        config: globalConfig,
      })
    );
    expect(stream.filter((chunk) => chunk.event === "error")).toEqual([]);

    let state = await client.threads.getState<{
      keyOne: string;
      keyTwo: string;
    }>(thread.thread_id);

    expect(state.values).toMatchObject({
      keyOne: "value3",
      keyTwo: "value4",
    });

    // list-based updates
    await client.runs.wait(thread.thread_id, assistant.assistant_id, {
      input,
      config: globalConfig,
    });
    stream = await gatherIterator(
      client.runs.stream(thread.thread_id, assistant.assistant_id, {
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

    state = await client.threads.getState<{
      keyOne: string;
      keyTwo: string;
    }>(thread.thread_id);

    expect(state.values).toMatchObject({
      keyOne: "value1",
      keyTwo: "value2",
    });
  });
});

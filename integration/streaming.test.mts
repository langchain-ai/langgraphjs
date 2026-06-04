import { Client } from "@langchain/langgraph-sdk";
import { beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { gatherIterator, findLast } from "./utils.mts";

const sql = postgres(
  process.env.POSTGRES_URI ??
    "postgres://postgres:postgres@127.0.0.1:5433/postgres?sslmode=disable",
);

const API_URL = "http://localhost:9123";
const client = new Client<any>({ apiUrl: API_URL });

// Passed to all invocation requests as the graph uses this field for store-based
// shared state operations.
const globalConfig = {
  configurable: {
    user_id: "123",
  },
};

beforeAll(async () => {
  await sql`DELETE FROM thread`;
  await sql`DELETE FROM store`;
  await sql`DELETE FROM checkpoints`;
  await sql`DELETE FROM assistant WHERE metadata->>'created_by' is null OR metadata->>'created_by' != 'system'`;
});

/**
 * Helper to parse SSE chunks from a raw ReadableStream.
 * Returns an array of { event, data } objects.
 */
async function readSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  {
    timeout = 15_000,
    stopWhen,
  }: {
    timeout?: number;
    stopWhen?: (events: Array<{ event: string; data: any }>) => boolean;
  } = {},
): Promise<Array<{ event: string; data: any }>> {
  const decoder = new TextDecoder();
  const events: Array<{ event: string; data: any }> = [];
  let buffer = "";
  let currentEvent = "";
  let currentData = "";

  const deadline = Date.now() + timeout;

  function pushEvent() {
    if (currentEvent || currentData) {
      let parsed: any = currentData;
      try {
        parsed = JSON.parse(currentData);
      } catch {
        // keep as string
      }
      events.push({ event: currentEvent, data: parsed });
      currentEvent = "";
      currentData = "";
    }
  }

  while (Date.now() < deadline) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const readPromise = reader.read();
    const timeoutPromise = new Promise<{ done: true; value: undefined }>(
      (resolve) => {
        timer = setTimeout(
          () => resolve({ done: true, value: undefined }),
          Math.max(deadline - Date.now(), 0),
        );
      },
    );

    const { done, value } = await Promise.race([readPromise, timeoutPromise]);
    clearTimeout(timer);
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // Normalize \r\n → \n (server sends \r\n per SSE spec)
    buffer = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

    // Parse SSE frames from buffer
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line.startsWith("event:")) {
        currentEvent = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        currentData = line.slice(5).trim();
      } else if (line === "") {
        pushEvent();
      }
    }

    if (stopWhen && stopWhen(events)) break;
  }

  // Flush any partially accumulated SSE message
  pushEvent();

  reader.cancel().catch(() => {});
  return events;
}

describe("streaming edge cases", () => {
  it.concurrent("debug stream mode", { retry: 3 }, async () => {
    const assistant = await client.assistants.create({ graphId: "agent" });
    const thread = await client.threads.create();
    const input = {
      messages: [{ type: "human", content: "foo", id: "debug-test-msg" }],
    };

    const chunks = await gatherIterator(
      client.runs.stream(thread.thread_id, assistant.assistant_id, {
        input,
        streamMode: "debug",
        config: globalConfig,
      }),
    );

    expect(chunks.filter((i) => i.event === "error")).toEqual([]);

    // Should contain debug events
    const debugChunks = chunks.filter((i) => i.event === "debug");
    expect(debugChunks.length).toBeGreaterThan(0);

    // Debug events should contain task-level execution information
    // with details like node name (payload.name) or task payload
    const debugPayloads = debugChunks.map((c) => c.data);
    const hasTaskInfo = debugPayloads.some(
      (p) =>
        (p?.payload?.name != null) ||
        (p?.type === "task" || p?.type === "task_result") ||
        (p?.payload?.input != null || p?.payload?.result != null),
    );
    expect(hasTaskInfo).toBe(true);

    // Verify the metadata event still comes through
    const metadataChunk = chunks.find((i) => i.event === "metadata");
    expect(metadataChunk).toBeDefined();
    expect(metadataChunk!.data.run_id).toEqual(expect.any(String));
  });

  it.concurrent(
    "debug + checkpoints combined",
    { retry: 3 },
    async () => {
      const assistant = await client.assistants.create({ graphId: "agent" });
      const thread = await client.threads.create();
      const input = {
        messages: [
          { type: "human", content: "foo", id: "debug-cp-test-msg" },
        ],
      };

      const chunks = await gatherIterator(
        client.runs.stream(thread.thread_id, assistant.assistant_id, {
          input,
          streamMode: ["debug", "checkpoints"],
          config: globalConfig,
        }),
      );

      expect(chunks.filter((i) => i.event === "error")).toEqual([]);

      const eventTypes = new Set(chunks.map((i) => i.event));

      // Both debug and checkpoints events should be present
      expect(eventTypes.has("debug")).toBe(true);
      expect(eventTypes.has("checkpoints")).toBe(true);

      // Validate checkpoint events have the expected shape
      const checkpointChunks = chunks.filter((i) => i.event === "checkpoints");
      expect(checkpointChunks.length).toBeGreaterThan(0);

      for (const cp of checkpointChunks) {
        expect(cp.data).toHaveProperty("values");
        expect(cp.data).toHaveProperty("metadata");
        expect(cp.data.metadata).toHaveProperty("source");
        expect(cp.data.metadata).toHaveProperty("step");
        expect(cp.data).toHaveProperty("next");
        expect(Array.isArray(cp.data.next)).toBe(true);
      }

      // Verify debug events also present
      const debugChunks = chunks.filter((i) => i.event === "debug");
      expect(debugChunks.length).toBeGreaterThan(0);
    },
  );

  it.concurrent(
    "messages metadata schema",
    { retry: 3 },
    async () => {
      const assistant = await client.assistants.create({ graphId: "agent" });
      const thread = await client.threads.create();
      const input = {
        messages: [
          { type: "human", content: "foo", id: "msg-metadata-test" },
        ],
      };

      const chunks = await gatherIterator(
        client.runs.stream(thread.thread_id, assistant.assistant_id, {
          input,
          streamMode: "messages",
          config: globalConfig,
        }),
      );

      expect(chunks.filter((i) => i.event === "error")).toEqual([]);

      const eventTypes = new Set(chunks.map((i) => i.event));

      // The messages/metadata event should be present
      expect(eventTypes.has("messages/metadata")).toBe(true);

      // Find the metadata event and check it contains graph structure info
      const metadataEvents = chunks.filter(
        (i) => i.event === "messages/metadata",
      );
      expect(metadataEvents.length).toBeGreaterThan(0);

      // messages/metadata should contain graph-related information
      const metadataData = metadataEvents[0].data;
      expect(metadataData).toBeDefined();

      // Also verify the other expected message event types appear
      expect(eventTypes.has("messages/partial")).toBe(true);
      expect(eventTypes.has("messages/complete")).toBe(true);
    },
  );

  it.concurrent(
    "stream events with subgraphs",
    { retry: 3 },
    async () => {
      const assistant = await client.assistants.create({
        graphId: "weather",
      });
      const thread = await client.threads.create();

      // First run: goes until interrupt (weather graph has interruptBefore)
      const chunksFirstRun = await gatherIterator(
        client.runs.stream(thread.thread_id, assistant.assistant_id, {
          input: {
            messages: [
              { role: "human", content: "SF", id: "initial-message" },
            ],
          },
          streamMode: "events",
          streamSubgraphs: true,
          config: globalConfig,
        }),
      );

      expect(chunksFirstRun.filter((i) => i.event === "error")).toEqual([]);

      // Continue past the interrupt
      const chunks = await gatherIterator(
        client.runs.stream(thread.thread_id, assistant.assistant_id, {
          input: null,
          streamMode: "events",
          streamSubgraphs: true,
          config: globalConfig,
        }),
      );

      expect(chunks.filter((i) => i.event === "error")).toEqual([]);

      // Collect all event names from both runs
      const allChunks = [...chunksFirstRun, ...chunks];
      const eventNames = allChunks.map((i) => i.event);

      // Should have subgraph-namespaced events
      // Subgraph events look like: events|weather_graph:<uuid>
      const subgraphEvents = eventNames.filter((name) =>
        /^events\|weather_graph:/.test(name),
      );
      expect(subgraphEvents.length).toBeGreaterThan(0);
    },
  );

  it.concurrent(
    "resumable streams with subgraphs",
    { retry: 3, timeout: 15_000 },
    async () => {
      const assistant = await client.assistants.create({
        graphId: "weather",
      });
      const thread = await client.threads.create();

      // Start run until interrupt with resumable streaming
      const firstRunChunks = await gatherIterator(
        client.runs.stream(thread.thread_id, assistant.assistant_id, {
          input: {
            messages: [
              { role: "human", content: "SF", id: "initial-message" },
            ],
          },
          streamMode: ["values", "updates"],
          streamSubgraphs: true,
          streamResumable: true,
          config: globalConfig,
        }),
      );

      expect(firstRunChunks.filter((i) => i.event === "error")).toEqual([]);

      // Verify we hit the interrupt
      const threadState = await client.threads.get(thread.thread_id);
      expect(threadState.status).toBe("interrupted");

      // Continue the run past the interrupt, also with resumable
      type RunMetadata = { run_id: string; thread_id?: string };
      let onRunCreated: ((params: RunMetadata) => void) | undefined =
        undefined;
      const waitRun = new Promise<RunMetadata>((r) => (onRunCreated = r));

      const continueStream = client.runs.stream(
        thread.thread_id,
        assistant.assistant_id,
        {
          input: null,
          streamMode: ["values", "updates"],
          streamSubgraphs: true,
          streamResumable: true,
          config: globalConfig,
          onRunCreated,
        },
      );

      const [joinResult, sourceResult] = await Promise.all([
        (async () => {
          const { run_id } = await waitRun;
          // Wait a moment for events to buffer
          await new Promise((resolve) => setTimeout(resolve, 1500));
          return gatherIterator(
            client.runs.joinStream(thread.thread_id, run_id, {
              lastEventId: "-1",
            }),
          );
        })(),
        gatherIterator(continueStream),
      ]);

      // The joined stream with lastEventId: "-1" should replay all events
      expect(joinResult.length).toBeGreaterThan(0);

      // Check that subgraph-namespaced events appear in the replayed stream
      const subgraphJoinEvents = joinResult.filter(
        (i) =>
          typeof i.event === "string" && /\|weather_graph:/.test(i.event),
      );
      expect(subgraphJoinEvents.length).toBeGreaterThan(0);

      // Join result should equal source result (full replay)
      expect(joinResult).toEqual(sourceResult);
    },
  );

  it.concurrent(
    "thread stream basic",
    { retry: 3, timeout: 20_000 },
    async () => {
      const thread = await client.threads.create();

      // Subscribe to the thread-level SSE stream
      const response = await fetch(
        `${API_URL}/threads/${thread.thread_id}/stream`,
        { headers: { "Last-Event-ID": "-" } },
      );
      expect(response.ok).toBe(true);
      const reader = response.body!.getReader();

      // Give the SSE connection a moment to establish
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Create two background runs with stream_resumable
      const run1 = await client.runs.create(
        thread.thread_id,
        "agent",
        {
          input: {
            messages: [
              { role: "human", content: "thread stream test 1" },
            ],
          },
          streamResumable: true,
          streamMode: "updates",
          config: globalConfig,
        },
      );

      const run2 = await client.runs.create(
        thread.thread_id,
        "agent",
        {
          input: {
            messages: [
              { role: "human", content: "thread stream test 2" },
            ],
          },
          streamResumable: true,
          streamMode: "updates",
          config: globalConfig,
          multitaskStrategy: "enqueue",
        },
      );

      // Read SSE events until we see run_done for both runs
      const seenRunsFinished: string[] = [];
      const events = await readSSEStream(reader, {
        timeout: 15_000,
        stopWhen: (evts) => {
          for (const evt of evts) {
            if (
              evt.data &&
              typeof evt.data === "object" &&
              evt.data.status === "run_done" &&
              !seenRunsFinished.includes(evt.data.run_id)
            ) {
              seenRunsFinished.push(evt.data.run_id);
            }
          }
          return seenRunsFinished.length >= 2;
        },
      });

      expect(events.length).toBeGreaterThan(0);
      expect(seenRunsFinished).toContain(run1.run_id);
      expect(seenRunsFinished).toContain(run2.run_id);
    },
  );

  it.concurrent(
    "thread stream lifecycle mode",
    { retry: 3, timeout: 20_000 },
    async () => {
      const thread = await client.threads.create();

      // Subscribe to thread-level SSE stream with lifecycle mode
      const response = await fetch(
        `${API_URL}/threads/${thread.thread_id}/stream?stream_modes=lifecycle`,
        { headers: { "Last-Event-ID": "-" } },
      );
      expect(response.ok).toBe(true);
      const reader = response.body!.getReader();

      // Give the SSE connection a moment to establish
      await new Promise((resolve) => setTimeout(resolve, 500));

      const run1 = await client.runs.create(
        thread.thread_id,
        "agent",
        {
          input: {
            messages: [
              { role: "human", content: "test lifecycle stream" },
            ],
          },
          streamResumable: true,
          streamMode: "updates",
          config: globalConfig,
        },
      );

      const run2 = await client.runs.create(
        thread.thread_id,
        "agent",
        {
          input: {
            messages: [
              { role: "human", content: "test lifecycle stream" },
            ],
          },
          streamResumable: true,
          streamMode: "updates",
          config: globalConfig,
          multitaskStrategy: "enqueue",
        },
      );

      // Read SSE events; lifecycle mode should emit run_start and run_done
      const seenRunsDone: string[] = [];
      const events = await readSSEStream(reader, {
        timeout: 15_000,
        stopWhen: (evts) => {
          for (const evt of evts) {
            if (
              evt.data &&
              typeof evt.data === "object" &&
              evt.data.status === "run_done" &&
              !seenRunsDone.includes(evt.data.run_id)
            ) {
              seenRunsDone.push(evt.data.run_id);
            }
          }
          return seenRunsDone.length >= 2;
        },
      });

      // Extract lifecycle events
      const runStartEvents = events.filter(
        (e) =>
          e.data &&
          typeof e.data === "object" &&
          "attempt" in e.data &&
          "run_id" in e.data,
      );
      const runDoneEvents = events.filter(
        (e) =>
          e.data &&
          typeof e.data === "object" &&
          e.data.status === "run_done",
      );

      // Should have exactly 2 start events and 2 done events
      expect(runStartEvents.length).toBe(2);
      expect(runDoneEvents.length).toBe(2);

      // Verify correct run IDs appear
      const startedRunIds = new Set(runStartEvents.map((e) => e.data.run_id));
      const finishedRunIds = new Set(runDoneEvents.map((e) => e.data.run_id));

      expect(startedRunIds).toContain(run1.run_id);
      expect(startedRunIds).toContain(run2.run_id);
      expect(finishedRunIds).toContain(run1.run_id);
      expect(finishedRunIds).toContain(run2.run_id);

      // In lifecycle mode the total number of events should be small
      // (just metadata/start + done for each run = 4 events)
      expect(events.length).toBe(4);
    },
  );

  it.concurrent(
    "stream echo preserves newlines",
    { retry: 3 },
    async () => {
      const assistant = await client.assistants.create({
        graphId: "agent_simple",
      });
      const thread = await client.threads.create();
      const input = {
        messages: [
          { role: "human", content: "foo", id: "newline-test-msg" },
        ],
      };

      const chunks = await gatherIterator(
        client.runs.stream(thread.thread_id, assistant.assistant_id, {
          input,
          streamMode: "values",
          config: globalConfig,
        }),
      );

      expect(chunks.filter((i) => i.event === "error")).toEqual([]);

      // Find the final values event
      const lastValues = findLast(
        chunks,
        (i): i is (typeof chunks)[number] => i.event === "values",
      );
      expect(lastValues).toBeDefined();

      // The agent_simple model returns "end\u2028" (with Unicode line separator)
      // Verify the \u2028 character survived the SSE bridge without corruption
      const messages = lastValues!.data.messages;
      expect(messages.length).toBeGreaterThan(0);
      const lastMessage = messages[messages.length - 1];

      // The final AI message should contain the \u2028 character
      expect(lastMessage.content).toContain("\u2028");
      expect(lastMessage.content).toBe("end\u2028");
    },
  );
});

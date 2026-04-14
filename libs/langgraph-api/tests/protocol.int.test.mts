import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { Client } from "@langchain/langgraph-sdk";

import { startServer } from "../src/server.mjs";

type ProtocolMessage = Record<string, any>;

class BufferedSocket {
  private readonly queue: ProtocolMessage[] = [];

  private readonly waiters: Array<{
    predicate: (payload: ProtocolMessage) => boolean;
    resolve: (payload: ProtocolMessage) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }> = [];

  constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      let payload: ProtocolMessage;
      try {
        payload = JSON.parse(String(event.data)) as ProtocolMessage;
      } catch {
        return;
      }

      const waiterIndex = this.waiters.findIndex((waiter) =>
        waiter.predicate(payload)
      );
      if (waiterIndex >= 0) {
        const [waiter] = this.waiters.splice(waiterIndex, 1);
        clearTimeout(waiter.timeout);
        waiter.resolve(payload);
        return;
      }

      this.queue.push(payload);
    });
  }

  async next(
    predicate: (payload: ProtocolMessage) => boolean,
    timeoutMs: number = 10_000
  ): Promise<ProtocolMessage> {
    const queuedIndex = this.queue.findIndex(predicate);
    if (queuedIndex >= 0) {
      return this.queue.splice(queuedIndex, 1)[0];
    }

    return new Promise<ProtocolMessage>((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        reject,
        timeout: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new Error("Timed out waiting for websocket message"));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  close() {
    this.socket.close();
  }
}

const TEST_PORT = 2234;
const TEST_API_URL = `http://127.0.0.1:${TEST_PORT}`;
const TEST_WS_URL = `ws://127.0.0.1:${TEST_PORT}`;
const globalConfig = { configurable: { user_id: "123" } };
const TEST_GRAPHS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "graphs"
);
const websocketIt =
  typeof WebSocket === "undefined" ? it.skip : it;

const createTestClient = () => new Client<any>({ apiUrl: TEST_API_URL });

let cleanupServer: (() => Promise<void>) | undefined;

afterEach(async () => {
  if (cleanupServer != null) {
    await Promise.race([
      cleanupServer(),
      new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    ]);
  }
  cleanupServer = undefined;
});

const startProtocolTestServer = async () => {
  const { cleanup } = await startServer({
    port: TEST_PORT,
    nWorkers: 2,
    host: "127.0.0.1",
    cwd: TEST_GRAPHS_DIR,
    graphs: {
      agent: "./agent.mts:graph",
      nested: "./nested.mts:graph",
      weather: "./weather.mts:graph",
      error: "./error.mts:graph",
      delay: "./delay.mts:graph",
      dynamic: "./dynamic.mts:graph",
      agent_simple: "./agent_simple.mts:graph",
      simple_runtime: "./simple_runtime.mts:graph",
      state_schema_graph: "./state_schema_graph.mts:graph",
      zod_registry_graph: "./zod_registry_graph.mts:graph",
      plain_zod_graph: "./plain_zod_graph.mts:graph",
    },
    http: {
      app: "./http.mts:app",
      disable_assistants: false,
      disable_threads: false,
      disable_runs: false,
      disable_store: false,
      disable_meta: false,
    },
    ui: {
      "agent-alias": "./agent/ui.tsx",
    },
  });
  cleanupServer = cleanup;
};

const readSseEvents = async (
  response: Response,
  options?: { expected?: number; timeoutMs?: number }
) => {
  const expected = options?.expected ?? 1;
  const timeoutMs = options?.timeoutMs ?? 10_000;
  const decoder = new TextDecoder();
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Expected SSE response body");

  const deadline = Date.now() + timeoutMs;
  let buffer = "";
  const events: Array<{ event?: string; data?: unknown; id?: string }> = [];

  while (events.length < expected && Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const chunk = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Timed out waiting for SSE event")), remaining)
      ),
    ]);

    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });

    while (true) {
      const separatorIndex = buffer.indexOf("\n\n");
      if (separatorIndex < 0) break;
      const rawEvent = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);

      const parsed: { event?: string; data?: unknown; id?: string } = {};
      const dataLines: string[] = [];
      for (const line of rawEvent.split("\n")) {
        if (line.startsWith("event:")) parsed.event = line.slice(6).trim();
        if (line.startsWith("id:")) parsed.id = line.slice(3).trim();
        if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
      }
      if (dataLines.length > 0) parsed.data = JSON.parse(dataLines.join("\n"));
      if (parsed.event != null || parsed.data != null) events.push(parsed);
    }
  }

  reader.releaseLock();
  return events;
};

describe("protocol transports", () => {
  websocketIt("supports session-based websocket protocol flow", async () => {
    await startProtocolTestServer();

    const socket = new WebSocket(`${TEST_WS_URL}/v2/runs`);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener(
        "error",
        () => reject(new Error("Failed to open websocket")),
        { once: true }
      );
    });

    const reader = new BufferedSocket(socket);
    socket.send(
      JSON.stringify({
        id: 0,
        method: "session.open",
        params: {
          protocol_version: "0.3.0",
          target: { kind: "graph", id: "nested" },
        },
      })
    );

    const openResponse = await reader.next(
      (payload) => payload.type === "success" && payload.id === 0
    );
    expect(openResponse).toMatchObject({
      type: "success",
      id: 0,
      result: {
        session_id: expect.any(String),
        protocol_version: "0.3.0",
        transport: {
          name: "websocket",
          command_delivery: "in-band",
        },
        capabilities: {
          modules: expect.arrayContaining([
            expect.objectContaining({ name: "session" }),
            expect.objectContaining({ name: "run" }),
            expect.objectContaining({ name: "subscription" }),
            expect.objectContaining({
              name: "agent",
              channels: ["lifecycle"],
            }),
            expect.objectContaining({
              name: "messages",
              channels: ["messages"],
            }),
            expect.objectContaining({
              name: "values",
              channels: ["values"],
            }),
            expect.objectContaining({
              name: "updates",
              channels: ["updates"],
            }),
          ]),
        },
      },
      meta: {
        session_id: expect.any(String),
        applied_through_seq: expect.any(Number),
      },
    });

    socket.send(
      JSON.stringify({
        id: 1,
        method: "subscription.subscribe",
        params: {
          channels: ["values", "updates"],
          namespaces: [["gp_two"]],
        },
      })
    );
    await reader.next((payload) => payload.type === "success" && payload.id === 1);

    socket.send(
      JSON.stringify({
        id: 2,
        method: "run.input",
        params: {
          input: { messages: ["input"] },
          config: globalConfig,
        },
      })
    );

    const runResponse = await reader.next(
      (payload) => payload.type === "success" && payload.id === 2
    );
    expect(runResponse).toMatchObject({
      type: "success",
      id: 2,
      result: { run_id: expect.any(String) },
    });

    const observedEvents: ProtocolMessage[] = [];
    while (true) {
      const payload = await reader.next((message) => message.type === "event");
      observedEvents.push(payload);

      if (
        payload.method === "values" &&
        JSON.stringify(payload.params?.data).includes("Entered c_two node")
      ) {
        break;
      }
    }

    expect(observedEvents.length).toBeGreaterThan(0);
    expect(
      observedEvents.every((event) =>
        ["values", "updates"].includes(String(event.method))
      )
    ).toBe(true);
    expect(
      observedEvents.every(
        (event) => /^gp_two(:|$)/.test((event.params?.namespace as string[] | undefined)?.[0] ?? "")
      )
    ).toBe(true);

    socket.send(
      JSON.stringify({
        id: 3,
        method: "agent.getTree",
        params: {},
      })
    );
    const treeResponse = await reader.next(
      (payload) => payload.type === "success" && payload.id === 3
    );
    expect(treeResponse).toMatchObject({
      type: "success",
      id: 3,
      result: {
        tree: {
          namespace: [],
          graph_name: "nested",
          children: [
            {
              namespace: [expect.stringMatching(/^gp_two(:|$)/)],
              children: [
                {
                  namespace: [
                    expect.stringMatching(/^gp_two(:|$)/),
                    expect.stringMatching(/^p_two(:|$)/),
                  ],
                },
              ],
            },
          ],
        },
      },
    });

    reader.close();
  });

  it("supports split HTTP+SSE protocol flow", async () => {
    await startProtocolTestServer();
    const threadId = crypto.randomUUID();

    const openResponse = await fetch(`${TEST_API_URL}/v2/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        method: "session.open",
        params: {
          protocol_version: "0.3.0",
          target: { kind: "graph", id: "nested" },
        },
      }),
    }).then((response) => response.json());

    expect(openResponse).toMatchObject({
      type: "success",
      result: {
        session_id: expect.any(String),
        transport: {
          name: "sse-http",
          command_delivery: "request-response",
        },
        capabilities: {
          modules: expect.arrayContaining([
            expect.objectContaining({
              name: "messages",
              channels: ["messages"],
            }),
            expect.objectContaining({
              name: "values",
              channels: ["values"],
            }),
            expect.objectContaining({
              name: "updates",
              channels: ["updates"],
            }),
          ]),
        },
        eventsUrl: expect.any(String),
        commandsUrl: expect.any(String),
      },
    });

    const sessionId = openResponse.result.session_id as string;
    const eventsResponse = await fetch(`${TEST_API_URL}/v2/sessions/${sessionId}/events`, {
      headers: { Accept: "text/event-stream" },
    });
    expect(eventsResponse.ok).toBe(true);

    const subscribeResponse = await fetch(
      `${TEST_API_URL}/v2/sessions/${sessionId}/commands`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: 1,
          method: "subscription.subscribe",
          params: {
            channels: ["values", "updates", "messages"],
            namespaces: [["gp_two"]],
          },
        }),
      }
    ).then((response) => response.json());

    expect(subscribeResponse).toMatchObject({
      type: "success",
      id: 1,
      result: {
        subscription_id: expect.any(String),
      },
      meta: {
        session_id: sessionId,
        applied_through_seq: expect.any(Number),
      },
    });

    const messagesSubscribeResponse = await fetch(
      `${TEST_API_URL}/v2/sessions/${sessionId}/commands`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: 11,
          method: "subscription.subscribe",
          params: {
            channels: ["messages"],
          },
        }),
      }
    ).then((response) => response.json());

    expect(messagesSubscribeResponse).toMatchObject({
      type: "success",
      id: 11,
      result: {
        subscription_id: expect.any(String),
      },
      meta: {
        session_id: sessionId,
        applied_through_seq: expect.any(Number),
      },
    });

    const runResponse = await fetch(`${TEST_API_URL}/v2/sessions/${sessionId}/commands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: 2,
        method: "run.input",
        params: {
          input: { messages: ["input"] },
          config: {
            configurable: {
              ...globalConfig.configurable,
              thread_id: threadId,
            },
          },
        },
      }),
    }).then((response) => response.json());

    expect(runResponse).toMatchObject({
      type: "success",
      id: 2,
      result: { run_id: expect.any(String) },
      meta: {
        session_id: sessionId,
        applied_through_seq: expect.any(Number),
      },
    });

    const events = await readSseEvents(eventsResponse, {
      expected: 2,
      timeoutMs: 10_000,
    });

    expect(events.some((event) => event.event === "values")).toBe(true);
    expect(events.every((event) => event.id != null)).toBe(true);
    expect(
      events
        .filter(
          (event) =>
            event.event === "values" || event.event === "updates"
        )
        .every(
          (event) =>
            ((event.data as any)?.params?.namespace as string[] | undefined)?.[0]?.startsWith(
              "gp_two"
            ) === true
        )
    ).toBe(true);
    const stateResponse = await fetch(`${TEST_API_URL}/v2/sessions/${sessionId}/commands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: 3,
        method: "state.get",
        params: {},
      }),
    }).then((response) => response.json());

    expect(stateResponse).toMatchObject({
      type: "success",
      id: 3,
      result: {
        checkpoint: {
          id: expect.any(String),
        },
      },
    });
  });

  it("streams message lifecycle deltas over session-based HTTP+SSE protocol", async () => {
    await startProtocolTestServer();
    const threadId = crypto.randomUUID();

    const openResponse = await fetch(`${TEST_API_URL}/v2/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        method: "session.open",
        params: {
          protocol_version: "0.3.0",
          target: { kind: "graph", id: "agent" },
        },
      }),
    }).then((response) => response.json());

    const sessionId = openResponse.result.session_id as string;
    const eventsResponse = await fetch(`${TEST_API_URL}/v2/sessions/${sessionId}/events`, {
      headers: { Accept: "text/event-stream" },
    });
    expect(eventsResponse.ok).toBe(true);

    const subscribeResponse = await fetch(
      `${TEST_API_URL}/v2/sessions/${sessionId}/commands`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: 1,
          method: "subscription.subscribe",
          params: {
            channels: ["messages"],
          },
        }),
      }
    ).then((response) => response.json());

    expect(subscribeResponse).toMatchObject({
      type: "success",
      id: 1,
      result: {
        subscription_id: expect.any(String),
      },
    });

    const runResponse = await fetch(`${TEST_API_URL}/v2/sessions/${sessionId}/commands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: 2,
        method: "run.input",
        params: {
          input: {
            messages: [
              { type: "human", content: "foo", id: "initial-message" },
            ],
          },
          config: {
            configurable: {
              ...globalConfig.configurable,
              thread_id: threadId,
            },
          },
        },
      }),
    }).then((response) => response.json());

    expect(runResponse).toMatchObject({
      type: "success",
      id: 2,
      result: { run_id: expect.any(String) },
    });

    const events = await readSseEvents(eventsResponse, {
      expected: 3,
      timeoutMs: 10_000,
    });

    expect(events.every((event) => event.event === "messages")).toBe(true);
    expect(
      events.map((event) => (event.data as any)?.params?.data?.event)
    ).toEqual(
      expect.arrayContaining([
        "message-start",
        "content-block-start",
        "content-block-delta",
      ])
    );
  });

  websocketIt("keeps compatibility run-scoped websocket protocol route", async () => {
    await startProtocolTestServer();

    const client = createTestClient();
    const assistant = await client.assistants.create({ graphId: "nested" });
    const thread = await client.threads.create();
    const run = await client.runs.create(thread.thread_id, assistant.assistant_id, {
      input: { messages: ["input"] },
      streamMode: ["values", "updates"],
      streamSubgraphs: true,
      streamResumable: true,
      config: globalConfig,
    });

    const socket = new WebSocket(
      `${TEST_WS_URL}/threads/${thread.thread_id}/runs/${run.run_id}/protocol`
    );

    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener(
        "error",
        () => reject(new Error("Failed to open websocket")),
        { once: true }
      );
    });

    const reader = new BufferedSocket(socket);
    socket.send(
      JSON.stringify({
        id: 1,
        method: "subscription.subscribe",
        params: {
          channels: ["values", "updates"],
          namespaces: [["gp_two"]],
        },
      })
    );

    const subscribeAck = await reader.next(
      (payload) => payload.type === "success" && payload.id === 1
    );
    expect(subscribeAck).toMatchObject({
      type: "success",
      id: 1,
      result: {
        subscription_id: expect.any(String),
        replayed_events: expect.any(Number),
      },
    });

    const observedEvents: ProtocolMessage[] = [];
    while (true) {
      const payload = await reader.next((message) => message.type === "event");
      observedEvents.push(payload);

      if (
        payload.method === "values" &&
        JSON.stringify(payload.params?.data).includes("Entered c_two node")
      ) {
        break;
      }
    }

    expect(observedEvents.length).toBeGreaterThan(0);
    expect(
      observedEvents.every((event) =>
        ["values", "updates"].includes(String(event.method))
      )
    ).toBe(true);
    expect(
      observedEvents.every(
        (event) => /^gp_two(:|$)/.test((event.params?.namespace as string[] | undefined)?.[0] ?? "")
      )
    ).toBe(true);

    socket.send(
      JSON.stringify({
        id: 2,
        method: "agent.getTree",
        params: {},
      })
    );
    const treeResponse = await reader.next(
      (payload) => payload.type === "success" && payload.id === 2
    );
    expect(treeResponse).toMatchObject({
      type: "success",
      id: 2,
      result: {
        tree: {
          namespace: [],
          graph_name: "nested",
          children: [
            {
              namespace: [expect.stringMatching(/^gp_two(:|$)/)],
              children: [
                {
                  namespace: [
                    expect.stringMatching(/^gp_two(:|$)/),
                    expect.stringMatching(/^p_two(:|$)/),
                  ],
                },
              ],
            },
          ],
        },
      },
    });

    reader.close();
    await client.runs.join(thread.thread_id, run.run_id);
    const runState = await client.runs.get(thread.thread_id, run.run_id);
    expect(runState.status).toBe("success");
  });
});

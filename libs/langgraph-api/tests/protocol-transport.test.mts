import { type ChildProcess, spawn } from "node:child_process";

import { Client } from "@langchain/langgraph-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import waitPort from "wait-port";

import { truncate } from "./utils.mjs";

const TEST_SERVER_PORT = process.env.CI ? "2026" : "2024";
const API_URL = `http://localhost:${TEST_SERVER_PORT}`;
const client = new Client<any>({ apiUrl: API_URL });
let server: ChildProcess | undefined;

const globalConfig = { configurable: { user_id: "123" } };

const createSocketCollector = (socket: WebSocket) => {
  const queue: unknown[] = [];
  const waiters: Array<(payload: unknown) => void> = [];

  socket.addEventListener("message", (event) => {
    const payload = JSON.parse(String(event.data));
    const waiter = waiters.shift();
    if (waiter) {
      waiter(payload);
    } else {
      queue.push(payload);
    }
  });

  return {
    async next<T>(
      predicate: (payload: T) => boolean,
      options?: { timeoutMs?: number }
    ): Promise<T> {
      const timeoutMs = options?.timeoutMs ?? 10_000;
      const matchFromQueue = () => {
        const index = queue.findIndex((payload) => predicate(payload as T));
        if (index === -1) return undefined;
        return queue.splice(index, 1)[0] as T;
      };

      const queued = matchFromQueue();
      if (queued != null) return queued;

      return new Promise<T>((resolve, reject) => {
        const timeout = setTimeout(() => {
          const index = waiters.indexOf(onPayload);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error("Timed out waiting for websocket message"));
        }, timeoutMs);

        const onPayload = (payload: unknown) => {
          if (!predicate(payload as T)) {
            queue.push(payload);
            waiters.push(onPayload);
            return;
          }
          clearTimeout(timeout);
          resolve(payload as T);
        };

        waiters.push(onPayload);
      });
    },
  };
};

beforeAll(async () => {
  if (process.env.CI) {
    server = spawn(
      "tsx",
      ["./tests/utils.server.mts", "-c", "./graphs/langgraph.json"],
      {
        stdio: "overlapped",
        env: { ...process.env, PORT: TEST_SERVER_PORT },
        shell: true,
      }
    );

    server.stdout?.on("data", (data) => console.log(data.toString().trimEnd()));
    server.stderr?.on("data", (data) => console.log(data.toString().trimEnd()));

    await waitPort({ port: Number(TEST_SERVER_PORT), timeout: 30_000 });
  }

  await truncate(API_URL, "all");
}, 60_000);

afterAll(() => server?.kill("SIGTERM"));

describe("protocol transport", () => {
  it.skipIf(typeof globalThis.WebSocket === "undefined").concurrent(
    "websocket filters and replays subscribed namespaces",
    { timeout: 20_000 },
    async () => {
      const assistant = await client.assistants.create({ graphId: "nested" });
      const thread = await client.threads.create();

      const socket = new WebSocket(
        `${API_URL.replace("http", "ws")}/v2/threads/${thread.thread_id}/stream`
      );
      const collector = createSocketCollector(socket);

      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener(
          "error",
          () => reject(new Error("Failed to open websocket")),
          { once: true }
        );
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

      const runInputRequestId = 2;
      socket.send(
        JSON.stringify({
          id: runInputRequestId,
          method: "run.start",
          params: {
            assistant_id: assistant.assistant_id,
            input: { messages: ["input"] },
            config: globalConfig,
          },
        })
      );

      const subscribeAck = await collector.next<Record<string, unknown>>(
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

      const observedEvents: Array<Record<string, unknown>> = [];
      while (true) {
        const payload = await collector.next<Record<string, unknown>>(
          (message) => message.type === "event"
        );
        observedEvents.push(payload);

        if (
          payload.method === "values" &&
          JSON.stringify(payload.params).includes("Entered c_two node")
        ) {
          break;
        }
      }

      expect(observedEvents.length).toBeGreaterThan(0);
      for (const event of observedEvents) {
        expect(
          event.method === "values" ||
            event.method === "updates" ||
            event.method === "lifecycle"
        ).toBe(true);
        expect(
          (event.params as { namespace: string[] }).namespace[0]
        ).toMatch(/^gp_two(:|$)/);
      }

      const treeRequestId = 3;
      socket.send(
        JSON.stringify({
          id: treeRequestId,
          method: "agent.getTree",
          params: {},
        })
      );

      const treeResponse = await collector.next<Record<string, unknown>>(
        (payload) => payload.type === "success" && payload.id === treeRequestId
      );
      expect(treeResponse).toMatchObject({
        type: "success",
        id: treeRequestId,
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

      const runInputAck = await collector.next<{
        type?: string;
        id?: number;
        result?: { run_id?: string };
      }>(
        (payload) =>
          payload.type === "success" && payload.id === runInputRequestId
      );
      const runId = runInputAck.result?.run_id;
      expect(runId).toEqual(expect.any(String));

      socket.close();
      await client.runs.join(thread.thread_id, runId!);
      const runState = await client.runs.get(thread.thread_id, runId!);
      expect(runState.status).toBe("success");
    }
  );
});

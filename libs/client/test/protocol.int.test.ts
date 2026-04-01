import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { AssembledMessage } from "../src/messages.js";
import { ProtocolSseTransportAdapter } from "../src/transport/index.js";
import { ProtocolClient } from "../src/session.js";
import {
  resetProtocolV2ServerState,
  startProtocolV2Server,
  TEST_API_URL,
} from "../../langgraph-api/tests/protocol-v2/utils.mjs";

const TEST_USER_ID = "protocol-v2-user";
let cleanupProtocolV2Server: (() => Promise<void>) | undefined;
let ownsProtocolV2Server = false;

const createClient = () =>
  new ProtocolClient(
    () =>
      new ProtocolSseTransportAdapter({
        apiUrl: TEST_API_URL,
      }),
  );

const createThreadId = (label: string) => `${label}-${crypto.randomUUID()}`;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitForProtocolV2Server(timeoutMs: number = 10_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      await fetch(TEST_API_URL);
      return;
    } catch {
      await sleep(100);
    }
  }

  throw new Error("Timed out waiting for protocol-v2 server startup.");
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${label}.`));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function collectUntil<T>(
  iterable: AsyncIterable<T>,
  predicate: (items: T[]) => boolean,
  label: string,
  timeoutMs: number = 20_000,
): Promise<T[]> {
  const items: T[] = [];
  const iterator = iterable[Symbol.asyncIterator]();
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const remaining = Math.max(deadline - Date.now(), 1);
    const result = await withTimeout(iterator.next(), remaining, label);
    if (result.done) {
      break;
    }

    items.push(result.value);
    if (predicate(items)) {
      return items;
    }
  }

  throw new Error(`Timed out collecting ${label}.`);
}

const messageText = (message: AssembledMessage) =>
  message.blocks
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");

const hasMessage = (
  messages: AssembledMessage[],
  namespace: string[],
  text: string,
) =>
  messages.some(
    (message) =>
      message.namespace.join("/") === namespace.join("/") &&
      messageText(message) === text,
  );

const parseJsonString = (value: unknown) => {
  if (typeof value !== "string") {
    return value;
  }

  return JSON.parse(value) as unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const extractToolOutputText = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(extractToolOutputText).join(" ");
  }

  if (!isRecord(value)) {
    return JSON.stringify(value);
  }

  if (typeof value.content === "string") {
    return value.content;
  }

  if (
    isRecord(value.update) &&
    Array.isArray(value.update.messages)
  ) {
    return value.update.messages.map(extractToolOutputText).join(" ");
  }

  return JSON.stringify(value);
};

describe.sequential("ProtocolClient protocol-v2 integration", () => {
  beforeAll(async () => {
    try {
      await fetch(TEST_API_URL);
    } catch {
      try {
        ({ cleanup: cleanupProtocolV2Server } = await startProtocolV2Server());
        ownsProtocolV2Server = true;
      } catch (error) {
        const maybeErrno = error as NodeJS.ErrnoException;
        if (maybeErrno.code !== "EADDRINUSE") {
          throw error;
        }
      }
    }

    await waitForProtocolV2Server();
  }, 30_000);

  beforeEach(async () => {
    await resetProtocolV2ServerState();
  }, 15_000);

  afterAll(async () => {
    if (!ownsProtocolV2Server) {
      return;
    }

    await cleanupProtocolV2Server?.();
    cleanupProtocolV2Server = undefined;
    ownsProtocolV2Server = false;
  }, 30_000);

  it("streams message events properly from a state graph instance", async () => {
    const client = createClient();
    const session = await client.open({
      protocolVersion: "0.3.0",
      target: { kind: "graph", id: "stategraph_text" },
    });

    try {
      const rawMessages = await session.subscribe("messages");

      const rawMessagesPromise = collectUntil(
        rawMessages,
        (events) =>
          events
            .filter((event) => event.params.data.event === "content-block-delta")
            .map((event) => {
              const block = event.params.data.contentBlock;
              return block.type === "text" ? block.text : "";
            })
            .join("") === "Plan accepted.",
        "stategraph message events",
      );

      await session.run.input({
        input: {
          messages: [
            { type: "human", content: "Summarize the protocol draft." },
          ],
        },
        config: {
          configurable: {
            thread_id: createThreadId("client-stategraph"),
            user_id: TEST_USER_ID,
          },
        },
      });

      const events = await rawMessagesPromise;

      expect(events[0]?.params.data.event).toBe("message-start");
      expect(events[1]?.params.data.event).toBe("content-block-start");
      expect(
        events
          .filter((event) => event.params.data.event === "content-block-delta")
          .map((event) => {
            const block = event.params.data.contentBlock;
            return block.type === "text" ? block.text : "";
          })
          .join(""),
      ).toBe("Plan accepted.");
      expect(events[0]?.params.namespace).toHaveLength(1);
      expect(events[0]?.params.namespace[0]).toMatch(/^agent:/);
      expect(
        events.every((event) =>
          ["message-start", "content-block-start", "content-block-delta"].includes(
            event.params.data.event,
          ),
        ),
      ).toBe(true);
      expect(session.ordering.lastSeenSeq).toBeGreaterThan(0);
    } finally {
      await session.close();
    }
  }, 20_000);

  it("can get messages and tool calls from sub agents", async () => {
    const client = createClient();
    const session = await client.open({
      protocolVersion: "0.3.0",
      target: { kind: "agent", id: "deep_agent" },
    });

    try {
      const subagentMessages = await session.subscribeMessages();
      const toolEvents = await session.subscribe("tools");

      const messagePromise = collectUntil(
        subagentMessages,
        (messages) =>
          hasMessage(
            messages,
            ["tools:task-1"],
            "Search the web for protocol risks",
          ) &&
          hasMessage(
            messages,
            ["tools:task-1"],
            "Research completed: reconnect and lifecycle handling need coverage.",
          ) &&
          hasMessage(
            messages,
            ["tools:task-2"],
            "Inspect the sample dataset",
          ) &&
          hasMessage(
            messages,
            ["tools:task-2"],
            "Analysis completed: found 2 sample records.",
          ),
        "subagent messages",
        30_000,
      );
      const toolEventsPromise = collectUntil(
        toolEvents,
        (events) =>
          events.some(
            (event) =>
              event.params.data.event === "tool-started" &&
              event.params.data.toolCallId === "task-1",
          ) &&
          events.some(
            (event) =>
              event.params.data.event === "tool-started" &&
              event.params.data.toolCallId === "task-2",
          ) &&
          events.some(
            (event) =>
              event.params.data.event === "tool-started" &&
              event.params.data.toolName === "search_web",
          ) &&
          events.some(
            (event) =>
              event.params.data.event === "tool-started" &&
              event.params.data.toolName === "query_database",
          ) &&
          events.some(
            (event) =>
              event.params.data.event === "tool-finished" &&
              event.params.data.toolCallId === "search-1",
          ) &&
          events.some(
            (event) =>
              event.params.data.event === "tool-finished" &&
              event.params.data.toolCallId === "query-1",
          ),
        "subagent tool events",
        30_000,
      );

      await session.run.input({
        input: {
          messages: [
            {
              type: "human",
              content:
                "Research protocol risks and inspect the sample dataset.",
            },
          ],
        },
        config: {
          configurable: {
            thread_id: createThreadId("client-deep-agent"),
            user_id: TEST_USER_ID,
          },
        },
      });

      const [messages, events] = await Promise.all([
        messagePromise,
        toolEventsPromise,
      ]);

      expect(
        messages
          .filter((message) => message.namespace[0] === "tools:task-1")
          .map(messageText),
      ).toEqual([
        "Search the web for protocol risks",
        "Research completed: reconnect and lifecycle handling need coverage.",
      ]);
      expect(
        messages
          .filter((message) => message.namespace[0] === "tools:task-2")
          .map(messageText),
      ).toEqual([
        "Inspect the sample dataset",
        "Analysis completed: found 2 sample records.",
      ]);

      const taskStartEvents = events.filter(
        (event) =>
          event.params.data.event === "tool-started" &&
          event.params.data.toolName === "task",
      );
      expect(taskStartEvents).toHaveLength(2);
      expect(taskStartEvents.every((event) => event.params.namespace.length === 1)).toBe(
        true,
      );
      expect(taskStartEvents.map((event) => parseJsonString(event.params.data.input))).toEqual(
        expect.arrayContaining([
          {
            description: "Search the web for protocol risks",
            subagent_type: "researcher",
          },
          {
            description: "Inspect the sample dataset",
            subagent_type: "data-analyst",
          },
        ]),
      );

      const nestedToolStarts = events.filter(
        (event) =>
          event.params.data.event === "tool-started" &&
          event.params.namespace.length === 2,
      );
      expect(
        nestedToolStarts.map((event) => event.params.data.toolName).sort(),
      ).toEqual(["query_database", "search_web"]);

      const searchFinished = events.find(
        (event) =>
          event.params.data.event === "tool-finished" &&
          event.params.data.toolCallId === "search-1",
      );
      const queryFinished = events.find(
        (event) =>
          event.params.data.event === "tool-finished" &&
          event.params.data.toolCallId === "query-1",
      );

      expect(searchFinished?.params.namespace).toHaveLength(2);
      expect(queryFinished?.params.namespace).toHaveLength(2);
      expect(extractToolOutputText(searchFinished?.params.data.output)).toContain(
        '"query":"protocol risks"',
      );
      expect(extractToolOutputText(queryFinished?.params.data.output)).toContain(
        '"table":"sample_data"',
      );
      expect(session.ordering.lastSeenSeq).toBeGreaterThan(0);
    } finally {
      await session.close();
    }
  }, 30_000);
});

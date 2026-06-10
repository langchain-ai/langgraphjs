import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Event, MessagesEvent } from "@langchain/protocol";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";

import { RootMessageProjection } from "./root-message-projection.js";
import { StreamStore } from "./store.js";
import { SubagentDiscovery } from "./discovery/index.js";
import type { RootSnapshot } from "./types.js";
import { ensureMessageInstances } from "./message-coercion.js";

interface State {
  messages?: unknown;
  cursor?: string;
}

function makeRootStore(): StreamStore<RootSnapshot<State, unknown>> {
  return new StreamStore<RootSnapshot<State, unknown>>({
    values: {} as State,
    messages: [],
    toolCalls: [],
    interrupts: [],
    interrupt: undefined,
    isLoading: false,
    isThreadLoading: false,
    error: undefined,
    threadId: null,
  });
}

function makeProjection() {
  const store = makeRootStore();
  const subagents = new SubagentDiscovery();
  const projection = new RootMessageProjection({
    messagesKey: "messages",
    store,
  });
  return { store, subagents, projection };
}

/**
 * Drain one macrotask so the projection's batched `setTimeout(0)`
 * flush commits to the store. The projection coalesces a burst of
 * synchronous writes (a microtask chain of SSE events) into one
 * `store.setState` at the next macrotask boundary, so every test
 * that asserts against the store after a `handleMessage` /
 * `applyValues` call has to drain a macrotask first.
 */
function drainFlush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function startEvent(
  data: {
    id?: string;
    role?: string;
    tool_call_id?: string;
    metadata?: unknown;
  },
  namespace: string[] = []
): MessagesEvent {
  return {
    type: "event",
    method: "messages",
    params: {
      namespace,
      timestamp: Date.now(),
      data: { event: "message-start", ...data },
    },
  } as unknown as MessagesEvent;
}

function blockStartEvent(
  index: number,
  block: { type: string; text?: string },
  namespace: string[] = []
): MessagesEvent {
  return {
    type: "event",
    method: "messages",
    params: {
      namespace,
      timestamp: Date.now(),
      data: { event: "content-block-start", index, content: block },
    },
  } as unknown as MessagesEvent;
}

function blockDeltaEvent(
  index: number,
  block: { type: string; text?: string },
  namespace: string[] = []
): MessagesEvent {
  return {
    type: "event",
    method: "messages",
    params: {
      namespace,
      timestamp: Date.now(),
      data: { event: "content-block-delta", index, content: block },
    },
  } as unknown as MessagesEvent;
}

function coreBlockDeltaEvent(
  index: number,
  delta: { type: "text-delta"; text: string },
  namespace: string[] = []
): MessagesEvent {
  return {
    type: "event",
    method: "messages",
    params: {
      namespace,
      timestamp: Date.now(),
      data: { event: "content-block-delta", index, delta },
    },
  } as unknown as MessagesEvent;
}

function usageEvent(namespace: string[] = []): MessagesEvent {
  return {
    type: "event",
    method: "messages",
    params: {
      namespace,
      timestamp: Date.now(),
      data: {
        event: "usage",
        usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
      },
    },
  } as unknown as MessagesEvent;
}

function parseSseFixture(path: URL): Event[] {
  const contents = readFileSync(path, "utf8");
  return contents
    .split(/\r?\n\r?\n+/)
    .flatMap((block) => {
      const dataLine = block
        .split(/\r?\n/)
        .find((line) => line.startsWith("data: "));
      return dataLine == null
        ? []
        : [JSON.parse(dataLine.slice("data: ".length)) as Event];
    });
}

function isInternalWorkNamespace(namespace: readonly string[]): boolean {
  return namespace.some(
    (segment) => segment.startsWith("tools:") || segment.startsWith("task:")
  );
}

async function replayRootProjection(events: readonly Event[]) {
  const { store, projection } = makeProjection();
  for (const event of events) {
    if (
      event.method === "messages" &&
      !isInternalWorkNamespace(event.params.namespace)
    ) {
      projection.handleMessage(event as MessagesEvent);
    } else if (
      event.method === "values" &&
      event.params.namespace.length === 0
    ) {
      const values = extractValuesState(event.params.data);
      const rawMessages = values.messages;
      projection.applyValues(
        values,
        Array.isArray(rawMessages) ? ensureMessageInstances(rawMessages) : []
      );
    }
  }
  await drainFlush();
  return store.getSnapshot();
}

function extractValuesState(data: unknown): State {
  if (data == null || typeof data !== "object" || Array.isArray(data)) {
    return {};
  }
  const record = data as Record<string, unknown>;
  if (
    record.values != null &&
    typeof record.values === "object" &&
    !Array.isArray(record.values)
  ) {
    return record.values as State;
  }
  return record as State;
}

function summarizeContent(content: unknown): unknown {
  if (typeof content === "string") {
    try {
      return JSON.parse(content);
    } catch {
      return content;
    }
  }
  if (Array.isArray(content)) {
    return content.map((block) => {
      if (block == null || typeof block !== "object") return block;
      const record = block as Record<string, unknown>;
      const summary: Record<string, unknown> = {
        type: record.type,
        id: record.id,
        name: record.name,
        args: record.args,
        text: record.text,
      };
      if ("reasoning" in record) summary.reasoning = record.reasoning;
      return summary;
    });
  }
  return content;
}

function summarizeMessage(
  message: RootSnapshot<State, unknown>["messages"][number]
) {
  const record = message as unknown as {
    tool_calls?: unknown;
    tool_call_id?: unknown;
    status?: unknown;
  };
  return {
    type: message.type,
    id: message.id,
    content: summarizeContent(message.content),
    tool_calls: record.tool_calls,
    tool_call_id: record.tool_call_id,
    status: record.status,
  };
}

describe("RootMessageProjection", () => {
  describe("handleMessage", () => {
    it("appends a new assembled message into the root snapshot", async () => {
      const { store, projection } = makeProjection();

      projection.handleMessage(startEvent({ id: "m1", role: "ai" }));
      projection.handleMessage(
        blockStartEvent(0, { type: "text", text: "Hi " })
      );
      projection.handleMessage(
        blockDeltaEvent(0, { type: "text", text: "there" })
      );

      await drainFlush();
      const snap = store.getSnapshot();
      expect(snap.messages).toHaveLength(1);
      expect(snap.messages[0].id).toBe("m1");
      expect(snap.messages[0].text).toBe("Hi there");
    });

    it("updates the same message index in place across deltas", async () => {
      const { store, projection } = makeProjection();

      projection.handleMessage(startEvent({ id: "m1", role: "ai" }));
      projection.handleMessage(blockStartEvent(0, { type: "text", text: "" }));
      projection.handleMessage(blockDeltaEvent(0, { type: "text", text: "a" }));
      await drainFlush();
      const after1 = store.getSnapshot().messages;

      projection.handleMessage(blockDeltaEvent(0, { type: "text", text: "b" }));
      await drainFlush();
      const after2 = store.getSnapshot().messages;

      expect(after2).toHaveLength(1);
      expect(after2[0].text).toBe("ab");
      // The array is replaced so React's identity check fires.
      expect(after2).not.toBe(after1);
    });

    it("applies typed content-block deltas", async () => {
      const { store, projection } = makeProjection();

      projection.handleMessage(startEvent({ id: "m1", role: "ai" }));
      projection.handleMessage(blockStartEvent(0, { type: "text", text: "" }));
      projection.handleMessage(
        coreBlockDeltaEvent(0, { type: "text-delta", text: "Hi" })
      );
      projection.handleMessage(
        coreBlockDeltaEvent(0, { type: "text-delta", text: " there" })
      );

      await drainFlush();
      const snap = store.getSnapshot();
      expect(snap.messages).toHaveLength(1);
      expect(snap.messages[0].text).toBe("Hi there");
    });

    it("mirrors messages into values[messagesKey]", async () => {
      const { store, projection } = makeProjection();

      projection.handleMessage(startEvent({ id: "m1", role: "ai" }));
      projection.handleMessage(
        blockStartEvent(0, { type: "text", text: "hi" })
      );

      await drainFlush();
      const values = store.getSnapshot().values as State;
      expect(Array.isArray(values.messages)).toBe(true);
      expect((values.messages as Array<{ id?: string }>)[0]?.id).toBe("m1");
    });

    it("does not duplicate an existing id on subsequent message-start events", async () => {
      const { store, projection } = makeProjection();

      projection.handleMessage(startEvent({ id: "m1", role: "ai" }));
      projection.handleMessage(
        blockStartEvent(0, { type: "text", text: "stable" })
      );

      // The protocol shouldn't re-send `message-start` for the same
      // id, but the projection must remain robust to it (the
      // assembler may treat it as a reset, but the projection
      // updates in place rather than appending a duplicate).
      projection.handleMessage(startEvent({ id: "m1", role: "ai" }));
      projection.handleMessage(
        blockStartEvent(0, { type: "text", text: "reset" })
      );

      await drainFlush();
      const after = store.getSnapshot();
      expect(after.messages).toHaveLength(1);
      expect(after.messages[0].id).toBe("m1");
    });

    it("uses message-start role to construct correct message classes", async () => {
      const { store, projection } = makeProjection();

      projection.handleMessage(startEvent({ id: "human-1", role: "human" }));
      projection.handleMessage(
        blockStartEvent(0, { type: "text", text: "hello" })
      );

      await drainFlush();
      const msg = store.getSnapshot().messages[0];
      expect(msg).toBeInstanceOf(HumanMessage);
    });

    it("recovers tool_call_id from the legacy `<id>-tool-<callId>` message id format", async () => {
      const { store, projection } = makeProjection();

      projection.handleMessage(
        startEvent({ id: "msg-tool-call_42", role: "tool" })
      );
      projection.handleMessage(
        blockStartEvent(0, { type: "text", text: "result" })
      );

      await drainFlush();
      const msg = store.getSnapshot().messages[0] as ToolMessage;
      expect(msg).toBeInstanceOf(ToolMessage);
      expect(msg.tool_call_id).toBe("call_42");
    });

    it("recovers tool_call_id from a recorded tool-started namespace mapping", async () => {
      const { store, projection } = makeProjection();

      projection.recordToolCallNamespace(["tools:abc"], "call_99");
      projection.handleMessage(
        startEvent({ id: "tool-msg", role: "tool" }, ["tools:abc"])
      );
      projection.handleMessage(
        blockStartEvent(0, { type: "text", text: "tool result" }, [
          "tools:abc",
        ])
      );

      await drainFlush();
      const msg = store.getSnapshot().messages[0] as ToolMessage;
      expect(msg.tool_call_id).toBe("call_99");
    });

    it("prefers an explicit tool_call_id on message-start over fallbacks", async () => {
      const { store, projection } = makeProjection();

      projection.recordToolCallNamespace(["tools:abc"], "call_namespace");
      projection.handleMessage(
        startEvent(
          {
            id: "msg-tool-call_legacy",
            role: "tool",
            tool_call_id: "call_explicit",
          },
          ["tools:abc"]
        )
      );
      projection.handleMessage(
        blockStartEvent(0, { type: "text", text: "x" }, ["tools:abc"])
      );

      await drainFlush();
      const msg = store.getSnapshot().messages[0] as ToolMessage;
      expect(msg.tool_call_id).toBe("call_explicit");
    });

    it("feeds new assembled messages into subagent discovery", async () => {
      const { subagents, projection } = makeProjection();
      // Subagent discovery runs synchronously inside `handleMessage`
      // (independent of the store-write flush), so no drain needed.

      // The simplest way to drive discovery is via the subagents'
      // value-flow, but we can also exercise the message-flow. Use a
      // tool_calls payload by going through a minimal assembled
      // message that includes a `task` tool call.
      // For the projection's contract we can verify that the subagent
      // discovery's snapshot reflects content visible after a delta.
      // The discovery layer is exercised more thoroughly in its own
      // unit suite, so we assert only the wiring (no throw, no
      // bypass).
      projection.handleMessage(startEvent({ id: "ai-1", role: "ai" }));
      projection.handleMessage(
        blockStartEvent(0, { type: "text", text: "hello" })
      );

      // No `task` tool call → no discovered subagents, but the call
      // path executed cleanly.
      expect(subagents.snapshot.size).toBe(0);
    });
  });

  describe("applyValues", () => {
    it("seeds messages from a values snapshot when nothing has streamed yet", async () => {
      const { store, projection } = makeProjection();

      const valueMsg = new AIMessage({ id: "a1", content: "values hello" });
      projection.applyValues(
        { messages: [valueMsg] } as State,
        [valueMsg]
      );

      await drainFlush();
      expect(store.getSnapshot().messages).toEqual([valueMsg]);
    });

    it("keeps streamed in-flight content while values dictates ordering", async () => {
      const { store, projection } = makeProjection();

      // Stream an AI message in.
      projection.handleMessage(startEvent({ id: "a1", role: "ai" }));
      projection.handleMessage(
        blockStartEvent(0, { type: "text", text: "streamed" })
      );

      // Values arrives with [human, ai] ordering and a stale ai content.
      const human = new HumanMessage({ id: "h1", content: "hi" });
      const aiFromValues = new AIMessage({ id: "a1", content: "stale" });
      projection.applyValues(
        { messages: [human, aiFromValues] } as State,
        [human, aiFromValues]
      );

      await drainFlush();
      const snap = store.getSnapshot();
      expect(snap.messages).toHaveLength(2);
      expect(snap.messages[0]).toBe(human);
      // Streamed AIMessage retained for its in-flight content.
      expect(snap.messages[1].text).toBe("streamed");
    });

    it("prefers the values version when it carries finalized tool-call data the stream lacks", async () => {
      const { store, projection } = makeProjection();

      // Stream an AI message with no tool calls.
      projection.handleMessage(startEvent({ id: "a1", role: "ai" }));
      projection.handleMessage(
        blockStartEvent(0, { type: "text", text: "" })
      );

      const finalized = new AIMessage({
        id: "a1",
        content: "",
        tool_calls: [{ id: "tc-1", name: "search", args: {} }],
      });
      projection.applyValues(
        { messages: [finalized] } as State,
        [finalized]
      );

      await drainFlush();
      const out = store.getSnapshot().messages[0] as AIMessage;
      expect(out.tool_calls).toHaveLength(1);
      expect(out.tool_calls?.[0]?.id).toBe("tc-1");
    });

    it("continues to process values snapshots after message usage events", async () => {
      const { store, projection } = makeProjection();

      projection.handleMessage(startEvent({ id: "a1", role: "ai" }, ["model:1"]));
      projection.handleMessage(
        blockStartEvent(0, { type: "text", text: "" }, ["model:1"])
      );
      projection.handleMessage(usageEvent(["model:1"]));

      const human = new HumanMessage({ id: "h1", content: "hi" });
      const ai = new AIMessage({
        id: "a1",
        content: "",
        tool_calls: [{ id: "tc-1", name: "calculator", args: {} }],
      });
      const tool = new ToolMessage({
        id: "t1",
        content: "42",
        tool_call_id: "tc-1",
      });
      const final = new AIMessage({ id: "a2", content: "The answer is 42." });

      projection.applyValues(
        { messages: [human, ai, tool, final] } as State,
        [human, ai, tool, final]
      );

      await drainFlush();
      expect(store.getSnapshot().messages.map((message) => message.id)).toEqual([
        "h1",
        "a1",
        "t1",
        "a2",
      ]);
    });

    it("replays the React agent tool-result stream fixture", async () => {
      const snapshot = await replayRootProjection(
        parseSseFixture(
          new URL(
            "../tests/fixtures/react-agent-tool-result-events.sse",
            import.meta.url
          )
        )
      );

      expect(snapshot.messages).not.toHaveLength(0);
      expect(snapshot.messages.map(summarizeMessage)).toMatchInlineSnapshot(`
        [
          {
            "content": "Use the calculator to add 12345 and 67890, then explain when you'd use this in code.",
            "id": "e89e07da-9da0-4ff7-9e25-5aec13f0a2f2",
            "status": undefined,
            "tool_call_id": undefined,
            "tool_calls": undefined,
            "type": "human",
          },
          {
            "content": [
              {
                "args": {
                  "expression": "12345 + 67890",
                },
                "id": "toolu_01RYpmgSmXeKZcyJWFNzNEt4",
                "name": "calculator",
                "text": undefined,
                "type": "tool_call",
              },
            ],
            "id": "msg_01U6vGrPqjfRQ8DbeuebcCxY",
            "status": undefined,
            "tool_call_id": undefined,
            "tool_calls": [
              {
                "args": {
                  "expression": "12345 + 67890",
                },
                "id": "toolu_01RYpmgSmXeKZcyJWFNzNEt4",
                "name": "calculator",
                "type": "tool_call",
              },
            ],
            "type": "ai",
          },
          {
            "content": {
              "expression": "12345 + 67890",
              "value": 80235,
            },
            "id": "run-019de07f-e2ba-761f-8ead-103bab194544-tool-toolu_01RYpmgSmXeKZcyJWFNzNEt4",
            "status": "success",
            "tool_call_id": "toolu_01RYpmgSmXeKZcyJWFNzNEt4",
            "tool_calls": undefined,
            "type": "tool",
          },
          {
            "content": [
              {
                "args": undefined,
                "id": undefined,
                "name": undefined,
                "text": "The result is **80,235**.

        ## When You'd Use This in Code

        You'd use addition like this in many practical scenarios:

        1. **Financial calculations** - Summing transaction amounts, calculating totals, or aggregating expenses
        2. **Data aggregation** - Combining counts, metrics, or measurements from different sources
        3. **Game development** - Calculating scores, health points, or resource totals
        4. **Analytics** - Summing page views, user counts, or performance metrics
        5. **Inventory management** - Adding quantities of items in stock
        6. **Form processing** - Totaling prices in a shopping cart or invoice

        In actual code, you'd typically do this with variables rather than hardcoded numbers:
        \`\`\`python
        amount1 = 12345
        amount2 = 67890
        total = amount1 + amount2
        print(total)  # Output: 80235
        \`\`\`

        This makes it reusable and dynamic based on real data from users, databases, or APIs.",
                "type": "text",
              },
            ],
            "id": "msg_01M6YsZj7Wn3ivDWCFZFrmt7",
            "status": undefined,
            "tool_call_id": undefined,
            "tool_calls": [],
            "type": "ai",
          },
        ]
      `);
    });

    it("replays the reasoning token stream fixture without collapsing reasoning blocks", async () => {
      const events = parseSseFixture(
        new URL("../tests/fixtures/reasoning-token-events.sse", import.meta.url)
      );
      const textDeltaSnapshot = await replayRootProjection(
        events.filter((event) => event.seq != null && event.seq <= 201)
      );
      const textDeltaAiMessage = textDeltaSnapshot.messages.find(
        AIMessage.isInstance
      );

      expect(summarizeMessage(textDeltaAiMessage!)).toMatchInlineSnapshot(`
        {
          "content": [
            {
              "args": undefined,
              "id": undefined,
              "name": undefined,
              "reasoning": "**Estimating multiplication mentally**

        The user",
              "text": undefined,
              "type": "reasoning",
            },
            {
              "args": undefined,
              "id": undefined,
              "name": undefined,
              "reasoning": "**Estimating multiplication methods**

        To",
              "text": undefined,
              "type": "reasoning",
            },
            {
              "args": undefined,
              "id": undefined,
              "name": undefined,
              "text": "Two quick mental approaches:

        ",
              "type": "text",
            },
          ],
          "id": "run-019e15fb-934e-7029-94f8-87176a5ffc6a",
          "status": undefined,
          "tool_call_id": undefined,
          "tool_calls": [],
          "type": "ai",
        }
      `);

      const snapshot = await replayRootProjection(events);

      expect(snapshot.messages).toHaveLength(2);
      expect(snapshot.messages.map(summarizeMessage)).toMatchInlineSnapshot(`
        [
          {
            "content": "Walk me through how you would estimate 17 × 24 mentally, then give the final number.",
            "id": "766e0564-a666-4fc9-8e78-e00a476eb9cd",
            "status": undefined,
            "tool_call_id": undefined,
            "tool_calls": undefined,
            "type": "human",
          },
          {
            "content": [
              {
                "args": undefined,
                "id": undefined,
                "name": undefined,
                "reasoning": "**Estimating multiplication mentally**

        The user wants to estimate 17 × 24 and then provide the final answer. I’ll start by showing techniques like rounding: I could round 17 to 20 and 24 to 25 to initially estimate 20 × 25, which equals 500, then adjust that down. 

        Using the distributive property, I could express it as 17 × (20 + 4), leading to 340 + 68, giving the actual final answer of 408. So, I’ll clearly walk through those two methods!",
                "text": undefined,
                "type": "reasoning",
              },
              {
                "args": undefined,
                "id": undefined,
                "name": undefined,
                "reasoning": "**Estimating multiplication methods**

        To estimate 17 × 24, I can round 17 to 20, which gives 20 × 24 = 480—an overestimate. Alternatively, rounding 24 to 25 gives 17 × 25 = 425, which is close; if I subtract 17 from that, it leads me to 408. I could also round both numbers together, resulting in 20 × 25 = 500, but that's even bigger. So, using the distributive property, the final answer is 408. I'll keep this clear and concise!",
                "text": undefined,
                "type": "reasoning",
              },
              {
                "args": undefined,
                "id": undefined,
                "name": undefined,
                "text": "Two quick mental approaches:

        ",
                "type": "text",
              },
            ],
            "id": "run-019e15fb-934e-7029-94f8-87176a5ffc6a",
            "status": undefined,
            "tool_call_id": undefined,
            "tool_calls": [],
            "type": "ai",
          },
        ]
      `);
    });

    it("drops messages removed from a later values snapshot", async () => {
      const { store, projection } = makeProjection();

      const a = new AIMessage({ id: "a1", content: "first" });
      const b = new AIMessage({ id: "a2", content: "second" });
      projection.applyValues(
        { messages: [a, b] } as State,
        [a, b]
      );
      await drainFlush();
      expect(store.getSnapshot().messages).toHaveLength(2);

      projection.applyValues(
        { messages: [a] } as State,
        [a]
      );
      await drainFlush();
      expect(store.getSnapshot().messages).toEqual([a]);
    });

    it("only updates values when messages are empty", async () => {
      const { store, projection } = makeProjection();

      projection.applyValues(
        { messages: [], cursor: "step-1" } as State,
        []
      );

      await drainFlush();
      const snap = store.getSnapshot();
      expect(snap.messages).toEqual([]);
      expect((snap.values as State).cursor).toBe("step-1");
    });

    it("preserves snapshot identity for repeated values snapshots", async () => {
      const { store, projection } = makeProjection();

      const a = new AIMessage({ id: "a1", content: "stable" });
      projection.applyValues(
        { messages: [a] } as State,
        [a]
      );
      await drainFlush();
      const before = store.getSnapshot();

      const aClone = new AIMessage({ id: "a1", content: "stable" });
      projection.applyValues(
        { messages: [aClone] } as State,
        [aClone]
      );

      await drainFlush();
      expect(store.getSnapshot()).toBe(before);
    });

    it("rebuilds the id index after a values reorder so subsequent deltas target the right slot", async () => {
      const { store, projection } = makeProjection();

      // Stream message a1 first.
      projection.handleMessage(startEvent({ id: "a1", role: "ai" }));
      projection.handleMessage(
        blockStartEvent(0, { type: "text", text: "alpha" })
      );

      // Values reorders [human, a1]; after this the assembler's
      // message index must point at slot 1, not 0.
      const human = new HumanMessage({ id: "h1", content: "hi" });
      const a1FromValues = new AIMessage({ id: "a1", content: "alpha" });
      projection.applyValues(
        { messages: [human, a1FromValues] } as State,
        [human, a1FromValues]
      );

      // Deliver a delta to a1 — should land at the new index (1).
      projection.handleMessage(
        blockDeltaEvent(0, { type: "text", text: "+more" })
      );

      await drainFlush();
      const snap = store.getSnapshot();
      expect(snap.messages).toHaveLength(2);
      expect(snap.messages[0]).toBe(human);
      expect(snap.messages[1].id).toBe("a1");
      expect(snap.messages[1].text).toContain("more");
    });
  });

  describe("sealMessageIds", () => {
    it("drops replayed streamed deltas for a sealed (idle-seeded) message", async () => {
      const { store, projection } = makeProjection();

      // Seed an idle thread's complete tail from getState, then seal it.
      const seeded = new AIMessage({ id: "a1", content: "All done." });
      projection.applyValues({ messages: [seeded] } as State, [seeded], {
        step: 5,
      });
      projection.sealMessageIds(["a1"]);
      await drainFlush();
      expect(store.getSnapshot().messages[0].text).toBe("All done.");

      // The deferred pump's seq=0 replay re-streams a1 from an empty
      // start. Without the seal this would clobber the seeded content
      // and re-stream the whole turn.
      projection.handleMessage(startEvent({ id: "a1", role: "ai" }));
      projection.handleMessage(blockStartEvent(0, { type: "text", text: "" }));
      projection.handleMessage(blockDeltaEvent(0, { type: "text", text: "A" }));

      await drainFlush();
      const snap = store.getSnapshot();
      expect(snap.messages).toHaveLength(1);
      expect(snap.messages[0].id).toBe("a1");
      expect(snap.messages[0].text).toBe("All done.");
    });

    it("still streams a non-sealed message id from the next run", async () => {
      const { store, projection } = makeProjection();

      const seeded = new AIMessage({ id: "a1", content: "All done." });
      projection.applyValues({ messages: [seeded] } as State, [seeded], {
        step: 5,
      });
      projection.sealMessageIds(["a1"]);
      await drainFlush();

      // The next run appends a brand-new id, which must stream normally.
      projection.handleMessage(startEvent({ id: "a2", role: "ai" }));
      projection.handleMessage(blockStartEvent(0, { type: "text", text: "" }));
      projection.handleMessage(
        blockDeltaEvent(0, { type: "text", text: "fresh" })
      );

      await drainFlush();
      const snap = store.getSnapshot();
      expect(snap.messages).toHaveLength(2);
      expect(snap.messages[0].text).toBe("All done.");
      expect(snap.messages[1].id).toBe("a2");
      expect(snap.messages[1].text).toBe("fresh");
    });

    it("lifts the seal once a newer checkpoint advances the timeline", async () => {
      const { store, projection } = makeProjection();

      const seeded = new AIMessage({ id: "a1", content: "All done." });
      projection.applyValues({ messages: [seeded] } as State, [seeded], {
        step: 5,
      });
      projection.sealMessageIds(["a1"]);

      // A genuinely newer checkpoint (step 6 > seed 5) means the live
      // timeline advanced past the replayed history, so the seal lifts.
      const advanced = new AIMessage({ id: "a1", content: "All done." });
      projection.applyValues({ messages: [advanced] } as State, [advanced], {
        step: 6,
      });

      // A later delta for a1 now streams again (seal lifted).
      projection.handleMessage(startEvent({ id: "a1", role: "ai" }));
      projection.handleMessage(
        blockStartEvent(0, { type: "text", text: "edited" })
      );

      await drainFlush();
      expect(store.getSnapshot().messages[0].text).toBe("edited");
    });

    it("does not lift on replayed checkpoints at or below the seed step", async () => {
      const { store, projection } = makeProjection();

      const seeded = new AIMessage({ id: "a1", content: "All done." });
      projection.applyValues({ messages: [seeded] } as State, [seeded], {
        step: 5,
      });
      projection.sealMessageIds(["a1"]);
      await drainFlush();

      // The deferred pump replays the finished run: its checkpoints are
      // at or below the seed step (5). They advance nothing past the
      // seal boundary, so the seal must hold.
      const replay = new AIMessage({ id: "a1", content: "All done." });
      projection.applyValues({ messages: [replay] } as State, [replay], {
        step: 4,
      });
      const replayAtSeed = new AIMessage({ id: "a1", content: "All done." });
      projection.applyValues(
        { messages: [replayAtSeed] } as State,
        [replayAtSeed],
        { step: 5 }
      );

      // Replayed messages deltas for a1 must still be dropped.
      projection.handleMessage(startEvent({ id: "a1", role: "ai" }));
      projection.handleMessage(blockStartEvent(0, { type: "text", text: "" }));
      projection.handleMessage(blockDeltaEvent(0, { type: "text", text: "A" }));

      await drainFlush();
      const snap = store.getSnapshot();
      expect(snap.messages).toHaveLength(1);
      expect(snap.messages[0].text).toBe("All done.");
    });

    it("holds the seal when the seed step is unknown and replay advances maxStep", async () => {
      const { store, projection } = makeProjection();

      // Idle thread whose getState() carried no metadata.step: the seed
      // applyValues has no step, so the projection starts with no
      // high-water mark and the seal boundary is unknown.
      const seeded = new AIMessage({ id: "a1", content: "All done." });
      projection.applyValues({ messages: [seeded] } as State, [seeded]);
      projection.sealMessageIds(["a1"]);
      await drainFlush();
      expect(store.getSnapshot().messages[0].text).toBe("All done.");

      // The deferred pump replays the finished run from seq=0: its values
      // checkpoints carry increasing steps that initialize and then
      // advance maxStep. These are replay, not a new run, so an unknown
      // seal boundary must NOT lift the seal (the bug this guards).
      const replay1 = new AIMessage({ id: "a1", content: "All done." });
      projection.applyValues({ messages: [replay1] } as State, [replay1], {
        step: 1,
      });
      const replay2 = new AIMessage({ id: "a1", content: "All done." });
      projection.applyValues({ messages: [replay2] } as State, [replay2], {
        step: 2,
      });

      // Replayed messages deltas for a1 must still be dropped.
      projection.handleMessage(startEvent({ id: "a1", role: "ai" }));
      projection.handleMessage(blockStartEvent(0, { type: "text", text: "" }));
      projection.handleMessage(blockDeltaEvent(0, { type: "text", text: "A" }));

      await drainFlush();
      const snap = store.getSnapshot();
      expect(snap.messages).toHaveLength(1);
      expect(snap.messages[0].text).toBe("All done.");
    });
  });

  describe("reset", () => {
    it("clears all per-thread state", async () => {
      const { store, projection } = makeProjection();

      projection.handleMessage(startEvent({ id: "a1", role: "ai" }));
      projection.handleMessage(
        blockStartEvent(0, { type: "text", text: "hello" })
      );
      projection.recordToolCallNamespace(["tools:1"], "call_1");
      await drainFlush();
      expect(store.getSnapshot().messages).toHaveLength(1);

      projection.reset();
      // reset() does not clear the store directly — that's the
      // controller's job — but it does drop the assembler / id
      // index / role cache so re-emitting the same `a1` won't be
      // treated as an in-place update.
      const beforeReplay = store.getSnapshot();

      projection.handleMessage(startEvent({ id: "a1", role: "ai" }));
      projection.handleMessage(
        blockStartEvent(0, { type: "text", text: "fresh" })
      );

      await drainFlush();
      const after = store.getSnapshot();
      // Without the reset, the projection would have reused index 0.
      // After reset, the new message is appended at the next slot.
      expect(after.messages.length).toBeGreaterThan(beforeReplay.messages.length);
    });

    it("re-clears the values-message id set so removals work after a thread swap", async () => {
      const { store, projection } = makeProjection();

      const a = new AIMessage({ id: "a1", content: "v1" });
      projection.applyValues({ messages: [a] } as State, [a]);
      await drainFlush();
      expect(store.getSnapshot().messages).toEqual([a]);

      // Simulate the controller resetting per-thread state on swap.
      projection.reset();

      // After reset, applying an empty values snapshot must not
      // implicitly remove any new streamed content. We can't observe
      // the internal id-set directly, but we can assert that an
      // unrelated stream message after reset doesn't get dropped by
      // a follow-up empty values snapshot.
      projection.handleMessage(startEvent({ id: "b1", role: "ai" }));
      projection.handleMessage(
        blockStartEvent(0, { type: "text", text: "fresh stream" })
      );

      projection.applyValues({ messages: [] } as State, []);
      await drainFlush();
      const messages = store.getSnapshot().messages;
      expect(messages.some((m) => m.id === "b1")).toBe(true);
    });
  });

  describe("scheduling", () => {
    // Two regressions live here:
    //
    //  1. The freeze that motivated PR #2384. When a long thread
    //     replays through the `messages` channel — on refresh, on
    //     resume of an in-flight run, or on a rapidly-streaming
    //     subagent — many events drain through the `for await` pump
    //     as a long microtask chain. Calling `store.setState` per
    //     event fires `useSyncExternalStore` notifications per
    //     event, and after enough notifications React's
    //     `nestedUpdateCount` guard trips with "Maximum update
    //     depth exceeded", freezing the UI on the first few messages.
    //
    //  2. PR #2384 itself, which fixed (1) by batching every write
    //     through a `MessageChannel` macrotask but broke initial-
    //     submit streaming — the user message and the streaming AI
    //     response never rendered in the live browser until refresh.
    //
    // The contract this projection guarantees:
    //   - A streamed event commits to the store within one
    //     macrotask, so React renders it on the very next paint.
    //   - A burst of events arriving in a single microtask chain
    //     collapses to a small, bounded number of store
    //     notifications.

    it("commits a streamed event within one macrotask so the next render sees it", async () => {
      const { store, projection } = makeProjection();

      projection.handleMessage(startEvent({ id: "m1", role: "ai" }));
      projection.handleMessage(
        blockStartEvent(0, { type: "text", text: "hello" })
      );

      // `drainFlush` is one `setTimeout(0)` — the same macrotask
      // boundary the projection schedules its flush on. By the time
      // it resolves, the store must reflect the streamed content.
      // A scheduler that needed more than one macrotask (a chain of
      // deferrals) would still show the pre-event state here and
      // break initial-submit streaming in the live browser.
      await drainFlush();
      const snap = store.getSnapshot();
      expect(snap.messages).toHaveLength(1);
      expect(snap.messages[0].text).toBe("hello");
    });

    it("commits a values snapshot within one macrotask", async () => {
      const { store, projection } = makeProjection();

      const human = new HumanMessage({ id: "h1", content: "hi" });
      projection.applyValues({ messages: [human] } as State, [human]);

      // Hydrate on thread bind goes through `applyValues`. The
      // hydrated state must be visible to React on the first paint
      // after thread navigation; an unbounded deferral chain here
      // would flash an empty state.
      await drainFlush();
      expect(store.getSnapshot().messages).toEqual([human]);
    });

    it("coalesces a synchronous burst of deltas so the store is notified a bounded number of times", async () => {
      const { store, projection } = makeProjection();
      let notifications = 0;
      store.subscribe(() => {
        notifications += 1;
      });

      projection.handleMessage(startEvent({ id: "m1", role: "ai" }));
      projection.handleMessage(
        blockStartEvent(0, { type: "text", text: "" })
      );
      const burst = 200;
      for (let i = 0; i < burst; i += 1) {
        projection.handleMessage(
          blockDeltaEvent(0, { type: "text", text: "x" })
        );
      }

      // Drain the next macrotask so the coalesced flush commits.
      await drainFlush();

      // Without batching, each delta calls `store.setState`, which
      // notifies once — over 200 notifications for this loop, which
      // is what trips React's `nestedUpdateCount` guard in the
      // browser. With macrotask coalescing the entire burst becomes
      // a single store notification.
      expect(notifications).toBeLessThan(10);
      // The final accumulated content has to commit by the time the
      // flush settles — losing the tail would mean stuck UI.
      expect(store.getSnapshot().messages[0].text.length).toBe(burst);
    });

    it("coalesces a long values replay into the store", async () => {
      const { store, projection } = makeProjection();
      let notifications = 0;
      store.subscribe(() => {
        notifications += 1;
      });

      // Many sequential `applyValues` calls in the same tick — what
      // a long-thread hydrate or a fast checkpoint replay looks like.
      for (let i = 0; i < 50; i += 1) {
        const a = new AIMessage({ id: `m${i}`, content: `v${i}` });
        projection.applyValues(
          { messages: [a] } as State,
          [a]
        );
      }

      await drainFlush();

      // The final snapshot must commit; otherwise the UI shows a
      // stale earlier replay step on first render.
      expect((store.getSnapshot().messages[0] as AIMessage).content).toBe(
        "v49"
      );
      // And the burst must coalesce — 50 sequential per-event
      // notifications is what trips React's nested-update guard.
      expect(notifications).toBeLessThan(10);
    });
  });

  describe("messagesKey customization", () => {
    it("respects an alternate messages key", async () => {
      const store = makeRootStore();
      const projection = new RootMessageProjection({
        messagesKey: "history",
        store,
      });

      projection.handleMessage(startEvent({ id: "m1", role: "ai" }));
      projection.handleMessage(
        blockStartEvent(0, { type: "text", text: "hi" })
      );

      await drainFlush();
      const values = store.getSnapshot().values as Record<string, unknown>;
      expect(Array.isArray(values.history)).toBe(true);
      expect(values.messages).toBeUndefined();
    });
  });

  describe("appendOptimistic", () => {
    it("appends an optimistic message after existing history", async () => {
      const { store, projection } = makeProjection();

      const existing = new AIMessage({ id: "a1", content: "prior" });
      projection.applyValues({ messages: [existing] } as State, [existing]);
      await drainFlush();

      const optimistic = new HumanMessage({ id: "h1", content: "hi" });
      projection.appendOptimistic([optimistic]);
      await drainFlush();

      const snap = store.getSnapshot();
      expect(snap.messages.map((m) => m.id)).toEqual(["a1", "h1"]);
    });

    it("merges non-message extraValues into values", async () => {
      const { store, projection } = makeProjection();

      const optimistic = new HumanMessage({ id: "h1", content: "hi" });
      projection.appendOptimistic([optimistic], { cursor: "pending" });
      await drainFlush();

      expect((store.getSnapshot().values as State).cursor).toBe("pending");
    });

    it("reconciles by id when the server echoes the message", async () => {
      const { store, projection } = makeProjection();

      const optimistic = new HumanMessage({ id: "h1", content: "hi" });
      projection.appendOptimistic([optimistic]);
      await drainFlush();

      // Server echoes [h1, a1] — no duplicate h1, ai appended.
      const echoed = new HumanMessage({ id: "h1", content: "hi" });
      const ai = new AIMessage({ id: "a1", content: "reply" });
      projection.applyValues({ messages: [echoed, ai] } as State, [echoed, ai]);
      await drainFlush();

      expect(store.getSnapshot().messages.map((m) => m.id)).toEqual([
        "h1",
        "a1",
      ]);
    });
  });

  describe("dropOptimisticMessages", () => {
    it("removes the given ids and preserves the rest", async () => {
      const { store, projection } = makeProjection();

      const a = new AIMessage({ id: "a1", content: "keep" });
      const h = new HumanMessage({ id: "h1", content: "drop" });
      projection.applyValues({ messages: [a] } as State, [a]);
      projection.appendOptimistic([h]);
      await drainFlush();

      projection.dropOptimisticMessages(new Set(["h1"]));
      await drainFlush();

      expect(store.getSnapshot().messages.map((m) => m.id)).toEqual(["a1"]);
    });
  });

  describe("restoreValueKeys", () => {
    it("restores a previously-existing key and deletes a new one", async () => {
      const { store, projection } = makeProjection();

      const h = new HumanMessage({ id: "h1", content: "hi" });
      projection.appendOptimistic([h], { cursor: "optimistic", added: "x" });
      await drainFlush();

      projection.restoreValueKeys([
        { key: "cursor", hadKey: true, prevValue: "prev" },
        { key: "added", hadKey: false, prevValue: undefined },
      ]);
      await drainFlush();

      const values = store.getSnapshot().values as Record<string, unknown>;
      expect(values.cursor).toBe("prev");
      expect("added" in values).toBe(false);
      // Messages are left intact (kept on failure).
      expect(store.getSnapshot().messages.map((m) => m.id)).toEqual(["h1"]);
    });
  });
});

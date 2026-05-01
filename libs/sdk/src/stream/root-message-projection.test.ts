import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Event, MessagesEvent } from "@langchain/protocol";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";

import { RootMessageProjection } from "./root-message-projection.js";
import { StreamStore } from "./store.js";
import { SubagentDiscovery } from "./discovery/index.js";
import type { RootSnapshot } from "./types.js";
import { ensureMessageInstances } from "../ui/messages.js";

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
    subagents,
  });
  return { store, subagents, projection };
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

function replayRootProjection(events: readonly Event[]) {
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
      return {
        type: record.type,
        id: record.id,
        name: record.name,
        args: record.args,
        text: record.text,
      };
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
    it("appends a new assembled message into the root snapshot", () => {
      const { store, projection } = makeProjection();

      projection.handleMessage(startEvent({ id: "m1", role: "ai" }));
      projection.handleMessage(
        blockStartEvent(0, { type: "text", text: "Hi " })
      );
      projection.handleMessage(
        blockDeltaEvent(0, { type: "text", text: "there" })
      );

      const snap = store.getSnapshot();
      expect(snap.messages).toHaveLength(1);
      expect(snap.messages[0].id).toBe("m1");
      expect(snap.messages[0].content).toBe("Hi there");
    });

    it("updates the same message index in place across deltas", () => {
      const { store, projection } = makeProjection();

      projection.handleMessage(startEvent({ id: "m1", role: "ai" }));
      projection.handleMessage(blockStartEvent(0, { type: "text", text: "" }));
      projection.handleMessage(blockDeltaEvent(0, { type: "text", text: "a" }));
      const after1 = store.getSnapshot().messages;

      projection.handleMessage(blockDeltaEvent(0, { type: "text", text: "b" }));
      const after2 = store.getSnapshot().messages;

      expect(after2).toHaveLength(1);
      expect(after2[0].content).toBe("ab");
      // The array is replaced so React's identity check fires.
      expect(after2).not.toBe(after1);
    });

    it("applies typed content-block deltas", () => {
      const { store, projection } = makeProjection();

      projection.handleMessage(startEvent({ id: "m1", role: "ai" }));
      projection.handleMessage(blockStartEvent(0, { type: "text", text: "" }));
      projection.handleMessage(
        coreBlockDeltaEvent(0, { type: "text-delta", text: "Hi" })
      );
      projection.handleMessage(
        coreBlockDeltaEvent(0, { type: "text-delta", text: " there" })
      );

      const snap = store.getSnapshot();
      expect(snap.messages).toHaveLength(1);
      expect(snap.messages[0].content).toBe("Hi there");
    });

    it("mirrors messages into values[messagesKey]", () => {
      const { store, projection } = makeProjection();

      projection.handleMessage(startEvent({ id: "m1", role: "ai" }));
      projection.handleMessage(
        blockStartEvent(0, { type: "text", text: "hi" })
      );

      const values = store.getSnapshot().values as State;
      expect(Array.isArray(values.messages)).toBe(true);
      expect((values.messages as Array<{ id?: string }>)[0]?.id).toBe("m1");
    });

    it("does not duplicate an existing id on subsequent message-start events", () => {
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

      const after = store.getSnapshot();
      expect(after.messages).toHaveLength(1);
      expect(after.messages[0].id).toBe("m1");
    });

    it("uses message-start role to construct correct message classes", () => {
      const { store, projection } = makeProjection();

      projection.handleMessage(startEvent({ id: "human-1", role: "human" }));
      projection.handleMessage(
        blockStartEvent(0, { type: "text", text: "hello" })
      );

      const msg = store.getSnapshot().messages[0];
      expect(msg).toBeInstanceOf(HumanMessage);
    });

    it("recovers tool_call_id from the legacy `<id>-tool-<callId>` message id format", () => {
      const { store, projection } = makeProjection();

      projection.handleMessage(
        startEvent({ id: "msg-tool-call_42", role: "tool" })
      );
      projection.handleMessage(
        blockStartEvent(0, { type: "text", text: "result" })
      );

      const msg = store.getSnapshot().messages[0] as ToolMessage;
      expect(msg).toBeInstanceOf(ToolMessage);
      expect(msg.tool_call_id).toBe("call_42");
    });

    it("recovers tool_call_id from a recorded tool-started namespace mapping", () => {
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

      const msg = store.getSnapshot().messages[0] as ToolMessage;
      expect(msg.tool_call_id).toBe("call_99");
    });

    it("prefers an explicit tool_call_id on message-start over fallbacks", () => {
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

      const msg = store.getSnapshot().messages[0] as ToolMessage;
      expect(msg.tool_call_id).toBe("call_explicit");
    });

    it("feeds new assembled messages into subagent discovery", () => {
      const { subagents, projection } = makeProjection();

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
    it("seeds messages from a values snapshot when nothing has streamed yet", () => {
      const { store, projection } = makeProjection();

      const valueMsg = new AIMessage({ id: "a1", content: "values hello" });
      projection.applyValues(
        { messages: [valueMsg] } as State,
        [valueMsg]
      );

      expect(store.getSnapshot().messages).toEqual([valueMsg]);
    });

    it("keeps streamed in-flight content while values dictates ordering", () => {
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

      const snap = store.getSnapshot();
      expect(snap.messages).toHaveLength(2);
      expect(snap.messages[0]).toBe(human);
      // Streamed AIMessage retained for its in-flight content.
      expect(snap.messages[1].content).toBe("streamed");
    });

    it("prefers the values version when it carries finalized tool-call data the stream lacks", () => {
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

      const out = store.getSnapshot().messages[0] as AIMessage;
      expect(out.tool_calls).toHaveLength(1);
      expect(out.tool_calls?.[0]?.id).toBe("tc-1");
    });

    it("continues to process values snapshots after message usage events", () => {
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

      expect(store.getSnapshot().messages.map((message) => message.id)).toEqual([
        "h1",
        "a1",
        "t1",
        "a2",
      ]);
    });

    it("replays the React agent tool-result stream fixture", () => {
      const snapshot = replayRootProjection(
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
            "content": "The result is **80,235**.

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
            "id": "msg_01M6YsZj7Wn3ivDWCFZFrmt7",
            "status": undefined,
            "tool_call_id": undefined,
            "tool_calls": [],
            "type": "ai",
          },
        ]
      `);
    });

    it("drops messages removed from a later values snapshot", () => {
      const { store, projection } = makeProjection();

      const a = new AIMessage({ id: "a1", content: "first" });
      const b = new AIMessage({ id: "a2", content: "second" });
      projection.applyValues(
        { messages: [a, b] } as State,
        [a, b]
      );
      expect(store.getSnapshot().messages).toHaveLength(2);

      projection.applyValues(
        { messages: [a] } as State,
        [a]
      );
      expect(store.getSnapshot().messages).toEqual([a]);
    });

    it("only updates values when messages are empty", () => {
      const { store, projection } = makeProjection();

      projection.applyValues(
        { messages: [], cursor: "step-1" } as State,
        []
      );

      const snap = store.getSnapshot();
      expect(snap.messages).toEqual([]);
      expect((snap.values as State).cursor).toBe("step-1");
    });

    it("preserves snapshot identity for repeated values snapshots", () => {
      const { store, projection } = makeProjection();

      const a = new AIMessage({ id: "a1", content: "stable" });
      projection.applyValues(
        { messages: [a] } as State,
        [a]
      );
      const before = store.getSnapshot();

      const aClone = new AIMessage({ id: "a1", content: "stable" });
      projection.applyValues(
        { messages: [aClone] } as State,
        [aClone]
      );

      expect(store.getSnapshot()).toBe(before);
    });

    it("rebuilds the id index after a values reorder so subsequent deltas target the right slot", () => {
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

      const snap = store.getSnapshot();
      expect(snap.messages).toHaveLength(2);
      expect(snap.messages[0]).toBe(human);
      expect(snap.messages[1].id).toBe("a1");
      expect(String(snap.messages[1].content)).toContain("more");
    });
  });

  describe("reset", () => {
    it("clears all per-thread state", () => {
      const { store, projection } = makeProjection();

      projection.handleMessage(startEvent({ id: "a1", role: "ai" }));
      projection.handleMessage(
        blockStartEvent(0, { type: "text", text: "hello" })
      );
      projection.recordToolCallNamespace(["tools:1"], "call_1");
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

      const after = store.getSnapshot();
      // Without the reset, the projection would have reused index 0.
      // After reset, the new message is appended at the next slot.
      expect(after.messages.length).toBeGreaterThan(beforeReplay.messages.length);
    });

    it("re-clears the values-message id set so removals work after a thread swap", () => {
      const { store, projection } = makeProjection();

      const a = new AIMessage({ id: "a1", content: "v1" });
      projection.applyValues({ messages: [a] } as State, [a]);
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
      const messages = store.getSnapshot().messages;
      expect(messages.some((m) => m.id === "b1")).toBe(true);
    });
  });

  describe("messagesKey customization", () => {
    it("respects an alternate messages key", () => {
      const store = makeRootStore();
      const subagents = new SubagentDiscovery();
      const projection = new RootMessageProjection({
        messagesKey: "history",
        store,
        subagents,
      });

      projection.handleMessage(startEvent({ id: "m1", role: "ai" }));
      projection.handleMessage(
        blockStartEvent(0, { type: "text", text: "hi" })
      );

      const values = store.getSnapshot().values as Record<string, unknown>;
      expect(Array.isArray(values.history)).toBe(true);
      expect(values.messages).toBeUndefined();
    });
  });
});

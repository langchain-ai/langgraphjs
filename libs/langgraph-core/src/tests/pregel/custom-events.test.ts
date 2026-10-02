import type { ProtocolEvent } from "../../stream/types.js";
import { describe, expect, it } from "vitest";
import { dispatchCustomEvent } from "@langchain/core/callbacks/dispatch";
import { CallbackManager } from "@langchain/core/callbacks/manager";
import { StreamCustomEventHandler } from "../../pregel/stream.js";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import {
  AIMessage,
  AIMessageChunk,
  BaseMessage,
  HumanMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { Annotation, StateGraph, START, END, getWriter } from "../../index.js";
import { FakeChatModel } from "../utils.models.js";

const State = Annotation.Root({ value: Annotation<number>() });
const makeGraph = () =>
  new StateGraph(State)
    .addNode("emit", async ({ value }) => {
      const payload = { value };
      await dispatchCustomEvent("progress", payload);
      payload.value += 1;
      await dispatchCustomEvent("progress", payload);
      getWriter()?.({ name: "writer", payload: { value } });
      return { value };
    })
    .addEdge(START, "emit")
    .addEdge("emit", END)
    .compile();

async function collect(stream: AsyncIterable<ProtocolEvent>) {
  const events = [];
  for await (const event of stream)
    if (event.method === "custom") events.push(event.params);
  return events;
}

describe("V3 callback custom events", () => {
  it("preserves callbacks, dispatch snapshots, and writer events", async () => {
    const observed: string[] = [];
    class Observer extends BaseCallbackHandler {
      name = "observer";
      awaitHandlers = true;
      handleCustomEvent(name: string) {
        observed.push(name);
      }
    }
    const graph = makeGraph().withConfig({ callbacks: [new Observer()] });
    const events = await collect(
      await graph.streamEvents({ value: 3 }, { version: "v3" })
    );
    expect(events.map((event) => event.data)).toEqual([
      { name: "progress", payload: { value: 3 } },
      { name: "progress", payload: { value: 4 } },
      { name: "writer", payload: { value: 3 } },
    ]);
    expect(observed).toEqual(["progress", "progress"]);
  });

  it("does not duplicate callbacks inherited by subgraphs", async () => {
    const graph = new StateGraph(State)
      .addNode("child", makeGraph())
      .addEdge(START, "child")
      .addEdge("child", END)
      .compile();
    const events = await collect(
      await graph.streamEvents({ value: 7 }, { version: "v3" })
    );
    expect(events).toHaveLength(3);
    expect(events[0].namespace).toHaveLength(1);
    expect(events[0].namespace[0]).toMatch(/^child:/);
  });

  it("isolates concurrently running streams", async () => {
    const graph = makeGraph();
    const [first, second] = await Promise.all([
      collect(await graph.streamEvents({ value: 10 }, { version: "v3" })),
      collect(await graph.streamEvents({ value: 20 }, { version: "v3" })),
    ]);
    expect(first.map((e) => e.data)).toMatchObject([
      { payload: { value: 10 } },
      { payload: { value: 11 } },
      { payload: { value: 10 } },
    ]);
    expect(second.map((e) => e.data)).toMatchObject([
      { payload: { value: 20 } },
      { payload: { value: 21 } },
      { payload: { value: 20 } },
    ]);
  });

  it("preserves callback manager instances without mutating their handlers", async () => {
    const observed: string[] = [];
    const manager = new CallbackManager();
    manager.addHandler(
      BaseCallbackHandler.fromMethods({
        handleCustomEvent: (name) => {
          observed.push(name);
        },
      })
    );
    const handlers = [...manager.handlers];
    await collect(
      await makeGraph()
        .withConfig({ callbacks: manager })
        .streamEvents({ value: 1 }, { version: "v3" })
    );
    expect(observed).toEqual(["progress", "progress"]);
    expect(manager.handlers).toEqual(handlers);
  });

  it("propagates stream delivery errors", async () => {
    const handler = new StreamCustomEventHandler(() => {
      throw new Error("closed stream");
    });
    expect(handler.awaitHandlers).toBe(true);
    expect(handler.raiseError).toBe(true);
    await expect(
      handler.handleCustomEvent("progress", {}, "run")
    ).rejects.toThrow("closed stream");
  });

  it("snapshots message classes and their current fields at dispatch", async () => {
    const message = new AIMessage({
      id: "ai",
      content: "constructor",
      tool_calls: [{ id: "tool", name: "lookup", args: { query: "before" } }],
    });
    message.content = "at dispatch";
    const payload = {
      messages: [
        message,
        new HumanMessage("question"),
        new ToolMessage({ content: "answer", tool_call_id: "tool" }),
        new AIMessageChunk({
          content: "chunk",
          tool_call_chunks: [
            { id: "chunk-tool", name: "lookup", args: '{"query":', index: 0 },
          ],
        }),
      ],
    };
    const expected = payload.messages.map((item) => ({
      ...item.toDict().data,
      type: item.getType(),
      content: item.content,
    }));
    const graph = new StateGraph(State)
      .addNode("emit", async () => {
        await dispatchCustomEvent("messages", payload);
        getWriter()?.({ name: "writer", payload: expected });
        message.content = "after dispatch";
        if (!message.tool_calls?.[0])
          throw new Error("Expected initial tool call");
        message.tool_calls[0].args.query = "after";
        return { value: 1 };
      })
      .addEdge(START, "emit")
      .addEdge("emit", END)
      .compile();
    const events = await collect(
      await graph.streamEvents({ value: 0 }, { version: "v3" })
    );
    const callback = events[0].data as { payload: { messages: BaseMessage[] } };
    expect(callback.payload.messages.every(BaseMessage.isInstance)).toBe(true);
    const actual = callback.payload.messages.map((item) => ({
      ...item.toDict().data,
      type: item.getType(),
    }));
    expect(actual).toEqual((events[1].data as { payload: unknown }).payload);
    expect(actual[0]).toMatchObject({
      content: "at dispatch",
      tool_calls: [{ args: { query: "before" } }],
    });
    expect(callback.payload.messages[3]).toBeInstanceOf(AIMessageChunk);
  });

  it("honors application serialization hooks without exposing internal fields", async () => {
    class ApplicationValue {
      private internal = "not public";
      toJSON() {
        return { public: this.internal.length };
      }
    }
    const chunks: unknown[] = [];
    const handler = new StreamCustomEventHandler((chunk) => {
      chunks.push(chunk);
    });
    await handler.handleCustomEvent(
      "app",
      { item: new ApplicationValue() },
      "run"
    );
    expect(chunks).toEqual([
      [[], "custom", { name: "app", payload: { item: { public: 10 } } }],
    ]);
  });

  it("preserves V2 callback event delivery", async () => {
    const events = [];
    for await (const event of makeGraph().streamEvents(
      { value: 1 },
      { version: "v2" }
    )) {
      if (event.event === "on_custom_event") events.push(event.name);
    }
    expect(events).toEqual(["progress", "progress"]);
  });

  it("preserves metadata and distinguishes model and returned messages", async () => {
    const Messages = Annotation.Root({ messages: Annotation<AIMessage[]>() });
    const model = new FakeChatModel({ responses: [new AIMessage("live")] });
    const graph = new StateGraph(Messages)
      .addNode("model", async () => ({
        messages: [
          await model.invoke([], { metadata: { application_hint: "kept" } }),
        ],
      }))
      .addNode("returned", () => ({
        messages: [new AIMessage({ content: "returned", id: "returned" })],
      }))
      .addEdge(START, "model")
      .addEdge("model", "returned")
      .addEdge("returned", END)
      .compile();
    const starts = [];
    for await (const event of await graph.streamEvents(
      { messages: [] },
      { version: "v3" }
    )) {
      if (
        event.method === "messages" &&
        typeof event.params.data === "object" &&
        event.params.data !== null &&
        "event" in event.params.data &&
        event.params.data.event === "message-start"
      )
        starts.push(event.params.data);
    }
    expect(starts).toHaveLength(2);
    expect(starts[0]).toMatchObject({
      metadata: { langgraph_message_source: "model", application_hint: "kept" },
    });
    expect(starts[1]).toMatchObject({
      metadata: {
        langgraph_message_source: "node",
        langgraph_node: "returned",
      },
    });
  });
});

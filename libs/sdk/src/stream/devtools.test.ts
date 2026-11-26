import { AIMessage } from "@langchain/core/messages";
import type { Event } from "@langchain/protocol";
import { describe, expect, it, vi } from "vitest";
import { StreamController } from "./controller.js";
import {
  StreamDevtoolsSession,
  type StreamDevtoolsRecord,
} from "./devtools.js";

function event(method: string, data: unknown, seq: number): Event {
  return {
    type: "event",
    event_id: `event-${seq}`,
    seq,
    method,
    params: { namespace: [], timestamp: seq, data },
  } as Event;
}

function fixture() {
  let listener: (event: Event) => void = () => undefined;
  let deliver: ((result: IteratorResult<Event>) => void) | undefined;
  const queue: Event[] = [];
  let closed = false;
  const subscription = {
    close() {
      closed = true;
      deliver?.({ done: true, value: undefined });
    },
    async unsubscribe() {
      this.close();
    },
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<Event>> {
          const next = queue.shift();
          if (next) return Promise.resolve({ done: false, value: next });
          if (closed) return Promise.resolve({ done: true, value: undefined });
          return new Promise((resolve) => {
            deliver = resolve;
          });
        },
      };
    },
  };
  const thread = {
    subscribe: vi.fn(async () => subscription),
    onEvent: vi.fn((fn: typeof listener) => {
      listener = fn;
      return () => undefined;
    }),
    onError: vi.fn(() => () => undefined),
    startLifecycleWatcher: vi.fn(),
    close: vi.fn(async () => subscription.close()),
    interrupts: [],
  };
  const client = {
    threads: {
      getState: vi.fn(async () => ({
        values: {
          messages: [new AIMessage({ id: "seed", content: "baseline" })],
        },
        next: ["agent"],
      })),
      stream: vi.fn(() => thread),
    },
    runs: { cancel: vi.fn() },
  };
  return {
    client,
    thread,
    emit(value: Event) {
      listener(value);
      const resolve = deliver;
      deliver = undefined;
      if (resolve) resolve({ done: false, value });
      else queue.push(value);
    },
  };
}

describe("StreamDevtoolsSession", () => {
  it("records detached baselines and ordered root/wildcard deliveries, replays deltas, and restores live state", async () => {
    const records: StreamDevtoolsRecord[] = [];
    const session = new StreamDevtoolsSession({
      onRecord: (record) => records.push(record),
    });
    const { client, emit } = fixture();
    const controller = new StreamController({
      assistantId: "test",
      client: client as never,
      threadId: "thread",
      devtools: session,
    });
    await controller.hydrationPromise;
    await vi.waitFor(() =>
      expect(client.threads.stream).toHaveBeenCalledOnce()
    );
    expect(
      records.filter((record) => record.type === "baseline").at(-1)
    ).toMatchObject({
      snapshot: { messages: [{ type: "ai", content: "baseline" }] },
    });
    const baseline = records
      .filter((record) => record.type === "baseline")
      .at(-1)!;
    emit(
      event(
        "messages",
        { event: "message-start", id: "streamed", role: "ai" },
        1
      )
    );
    emit(
      event(
        "messages",
        {
          event: "content-block-delta",
          index: 0,
          content: { type: "text", text: "hello" },
        },
        2
      )
    );
    emit(
      event(
        "tools",
        {
          event: "tool-started",
          tool_call_id: "call",
          tool_name: "lookup",
          input: { q: "hi" },
        },
        3
      )
    );
    await vi.waitFor(() =>
      expect(records.filter((record) => record.type === "event")).toHaveLength(
        6
      )
    );
    const prefix = JSON.parse(
      JSON.stringify(records)
    ) as StreamDevtoolsRecord[];
    session.reset();
    prefix.forEach((record) => session.apply(record));
    session.flush();
    const replay = session.display(controller);
    expect(replay).not.toBe(controller);
    expect(replay.rootStore.getSnapshot().messages.at(-1)?.text).toBe("hello");
    expect(replay.rootStore.getSnapshot().toolCalls[0]).toMatchObject({
      id: "call",
      name: "lookup",
    });
    await expect(controller.submit({})).rejects.toThrow(
      "disabled during devtools replay"
    );
    await expect(replay.submit({})).rejects.toThrow(
      "disabled during devtools replay"
    );
    await expect(replay.stop()).rejects.toThrow(
      "disabled during devtools replay"
    );
    const recordedCount = records.length;
    session.reset();
    session.apply(baseline);
    session.flush();
    expect(
      session
        .display(controller)
        .rootStore.getSnapshot()
        .messages.map((message) => message.text)
    ).toEqual(["baseline"]);
    expect(records).toHaveLength(recordedCount);
    emit(
      event(
        "values",
        {
          marker: "live advanced",
          messages: [{ type: "ai", id: "latest", content: "live advanced" }],
        },
        4
      )
    );
    await vi.waitFor(() =>
      expect(controller.rootStore.getSnapshot().values).toHaveProperty(
        "marker",
        "live advanced"
      )
    );
    expect(
      session.display(controller).rootStore.getSnapshot().messages.at(-1)?.text
    ).toBe("baseline");
    session.live();
    expect(session.display(controller)).toBe(controller);
    expect(client.threads.getState).toHaveBeenCalledOnce();
    expect(client.threads.stream).toHaveBeenCalledOnce();
    expect(client.runs.cancel).not.toHaveBeenCalled();
    await controller.dispose();
  });

  it("flushes lifecycle transitions and input channels without callbacks or network", async () => {
    const session = new StreamDevtoolsSession({ onRecord: vi.fn() });
    const onCompleted = vi.fn();
    const client = { threads: { stream: vi.fn(), getState: vi.fn() } };
    const controller = new StreamController({
      assistantId: "test",
      client: client as never,
      devtools: session,
      onCompleted,
    });
    session.reset();
    session.apply({
      version: 1,
      type: "event",
      source: "wildcard",
      event: event("lifecycle", { event: "running" }, 1),
    });
    session.apply({
      version: 1,
      type: "event",
      source: "wildcard",
      event: event(
        "input.requested",
        { interrupt_id: "input", payload: "approve" },
        2
      ),
    });
    expect(
      session.display(controller).rootStore.getSnapshot().interrupt?.value
    ).toBe("approve");
    session.apply({
      version: 1,
      type: "event",
      source: "wildcard",
      event: event("input.answered", { interrupt_ids: ["input"] }, 3),
    });
    session.apply({
      version: 1,
      type: "event",
      source: "wildcard",
      event: event("lifecycle", { event: "completed" }, 4),
    });
    session.flush();
    expect(session.display(controller).rootStore.getSnapshot().isLoading).toBe(
      false
    );
    expect(
      session.display(controller).rootStore.getSnapshot().interrupts
    ).toEqual([]);
    expect(onCompleted).not.toHaveBeenCalled();
    expect(client.threads.stream).not.toHaveBeenCalled();
    expect(client.threads.getState).not.toHaveBeenCalled();
    await controller.dispose();
  });
  it("transfers controller ownership without mixing stale events or detaching the new owner", async () => {
    const records: StreamDevtoolsRecord[] = [];
    const session = new StreamDevtoolsSession({
      onRecord: (record) => records.push(record),
    });
    const first = fixture();
    const second = fixture();
    const old = new StreamController({
      assistantId: "first",
      client: first.client as never,
      threadId: "first",
      devtools: session,
    });
    await old.hydrationPromise;
    const current = new StreamController({
      assistantId: "second",
      client: second.client as never,
      threadId: "second",
      devtools: session,
    });
    await current.hydrationPromise;
    const count = records.length;
    first.emit(event("values", { marker: "stale" }, 1));
    await vi.waitFor(() =>
      expect(old.rootStore.getSnapshot().values).toHaveProperty(
        "marker",
        "stale"
      )
    );
    expect(records).toHaveLength(count);
    await old.dispose();
    session.reset();
    session.apply(records.at(-1)!);
    session.flush();
    expect(session.display(current).rootStore.getSnapshot().threadId).toBe(
      "second"
    );
    await current.dispose();
  });
});

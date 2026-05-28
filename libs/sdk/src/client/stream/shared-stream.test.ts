import { describe, expect, it } from "vitest";

import { ThreadStream } from "./index.js";
import { MockSseTransport, eventOf, nextValue } from "./test/utils.js";

/**
 * Tests covering the shared SSE stream invariants in `ThreadStream`.
 * See grilling session Q1–Q15 for the design decisions under test.
 *
 * Terminology:
 *   - "rotation" = open new SSE stream with a wider/narrower union filter,
 *     then close the old one (open-before-close overlap absorbed by
 *     `#seenEventIds` dedup).
 *   - "union filter" = permissive channel-union across all active subs
 *     (namespaces/depth dropped; client narrows via `matchesSubscription`).
 */

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("ThreadStream (SSE shared stream)", () => {
  it("opens at most one stream for multiple concurrent subscribes (coalesce)", async () => {
    const transport = new MockSseTransport();
    const thread = new ThreadStream(transport, { assistantId: "a" });

    await Promise.all([
      thread.subscribe({ channels: ["messages"] }),
      thread.subscribe({ channels: ["values"] }),
      thread.subscribe({ channels: ["tools"] }),
    ]);

    expect(transport.totalStreamCount).toBe(1);
    expect(transport.activeStreamCount).toBe(1);
    const filter = transport.lastFilter!;
    expect(new Set(filter.channels)).toEqual(
      new Set(["messages", "values", "tools"])
    );

    await thread.close();
  });

  it("rotates when a subscribe widens the channel union", async () => {
    const transport = new MockSseTransport();
    const thread = new ThreadStream(transport, { assistantId: "a" });

    await thread.subscribe({ channels: ["messages"] });
    expect(transport.totalStreamCount).toBe(1);

    await thread.subscribe({ channels: ["tools"] });
    expect(transport.totalStreamCount).toBe(2);
    expect(transport.activeStreamCount).toBe(1);
    expect(new Set(transport.lastFilter!.channels)).toEqual(
      new Set(["messages", "tools"])
    );

    await thread.close();
  });

  it("rotates on every subscribe so late joiners get a fresh server replay", async () => {
    const transport = new MockSseTransport();
    const thread = new ThreadStream(transport, { assistantId: "a" });

    // Every subscribe opens a fresh SSE even when the union filter is
    // unchanged: the server replays buffered events only at the moment
    // the connection is opened, so a late-joining sub otherwise misses
    // anything that arrived before it registered. Per-sub
    // `seenEventIds` keeps existing subs from seeing the replay as
    // duplicates.
    await thread.subscribe({ channels: ["messages", "values"] });
    expect(transport.totalStreamCount).toBe(1);

    await thread.subscribe({ channels: ["messages"] });
    expect(transport.totalStreamCount).toBe(2);

    await thread.subscribe({
      channels: ["values"],
      namespaces: [["agent_1"]],
    });
    expect(transport.totalStreamCount).toBe(3);
    expect(transport.activeStreamCount).toBe(1);

    await thread.close();
  });

  it("rotates when an unsubscribe strictly shrinks the channel union", async () => {
    const transport = new MockSseTransport();
    const thread = new ThreadStream(transport, { assistantId: "a" });

    const a = await thread.subscribe({ channels: ["messages"] });
    const b = await thread.subscribe({ channels: ["tools"] });
    expect(transport.totalStreamCount).toBe(2);

    await b.unsubscribe();
    await flush();
    expect(transport.totalStreamCount).toBe(3);
    expect(new Set(transport.lastFilter!.channels)).toEqual(
      new Set(["messages"])
    );

    await a.unsubscribe();
    await thread.close();
  });

  it("does not rotate when an unsubscribe leaves the union unchanged", async () => {
    const transport = new MockSseTransport();
    const thread = new ThreadStream(transport, { assistantId: "a" });

    // Two subscribes always produce two rotations (replay-on-subscribe
    // correctness); the interesting invariant here is that
    // *unsubscribe* does not rotate when the union filter is
    // unchanged — the replay semantics only apply to newly-registered
    // subs, not to leaving ones.
    const a = await thread.subscribe({ channels: ["messages"] });
    const b = await thread.subscribe({ channels: ["messages"] });
    expect(transport.totalStreamCount).toBe(2);

    await b.unsubscribe();
    await flush();
    expect(transport.totalStreamCount).toBe(2);

    await a.unsubscribe();
    await thread.close();
  });

  it("does not pause subscriptions opened after a replayed terminal event", async () => {
    const transport = new MockSseTransport();
    const thread = new ThreadStream(transport, { assistantId: "a" });

    const root = await thread.subscribe({
      channels: ["lifecycle", "tools"],
      namespaces: [[]],
      depth: 1,
    });

    const terminal = eventOf(
      "lifecycle",
      { event: "completed" } as never,
      { namespace: [], seq: 10, eventId: "terminal" }
    );
    transport.pushEvent(terminal);
    await nextValue(root);
    await flush();

    const tools = await thread.subscribe({
      channels: ["tools"],
      namespaces: [["tools:task-1"]],
      depth: 1,
    });

    // Simulate an older overlapping stream replaying the already-seen terminal
    // after the late subscription is registered. The late subscription should
    // keep draining replayed history because it was created after seq 10.
    transport.pushEvent(terminal);
    await flush();

    const nestedTool = eventOf(
      "tools",
      {
        event: "tool-started",
        tool_call_id: "search-1",
        tool_name: "search_web",
        input: {},
      } as never,
      {
        namespace: ["tools:task-1", "tools:search-1"],
        seq: 11,
        eventId: "tool-started",
      }
    );
    transport.pushEvent(nestedTool);

    await expect(nextValue(tools)).resolves.toBe(nestedTool);

    await thread.close();
  });

  it("drains late values that arrive after root terminal pause", async () => {
    const transport = new MockSseTransport();
    const thread = new ThreadStream(transport, { assistantId: "a" });

    const root = await thread.subscribe({
      channels: ["lifecycle", "values"],
      namespaces: [[]],
      depth: 1,
    });

    const terminal = eventOf(
      "lifecycle",
      { event: "completed" } as never,
      { namespace: [], seq: 10, eventId: "completed" }
    );
    transport.pushEvent(terminal);
    await expect(nextValue(root)).resolves.toBe(terminal);
    await flush();
    expect(root.isPaused).toBe(true);

    const finalValues = eventOf(
      "values",
      { messages: [{ id: "ai-2", content: "Done." }] } as never,
      { namespace: [], seq: 11, eventId: "final-values" }
    );
    transport.pushEvent(finalValues);
    await flush();

    await expect(nextValue(root)).resolves.toBe(finalValues);
    await flush();
    expect(root.isPaused).toBe(true);

    await thread.close();
  });

  it("dedups events during rotation overlap (open-before-close)", async () => {
    const transport = new MockSseTransport();
    const thread = new ThreadStream(transport, { assistantId: "a" });

    const sub = await thread.subscribe({ channels: ["messages"] });

    transport.pushEvent(
      eventOf(
        "messages",
        { event: "message-start", id: "msg_1" } as never,
        { namespace: [], seq: 1, eventId: "evt_1" }
      )
    );
    await nextValue(sub);

    // Opening a new subscription on `tools` triggers a rotation whose
    // new stream replays the buffered `evt_1` alongside any `tools`
    // events. The `messages` subscription must NOT see `evt_1` twice.
    await thread.subscribe({ channels: ["tools"] });

    const second = await Promise.race([
      (async () => {
        const iter = sub[Symbol.asyncIterator]();
        return await iter.next();
      })(),
      new Promise<{ done: true }>((r) =>
        setTimeout(() => r({ done: true }), 30)
      ),
    ]);
    expect(second.done).toBe(true);

    await thread.close();
  });

  it("resolves subscribe() only after a covering stream is active (manualReady)", async () => {
    const transport = new MockSseTransport({ manualReady: true });
    const thread = new ThreadStream(transport, { assistantId: "a" });

    let resolved = false;
    const pending = thread
      .subscribe({ channels: ["messages"] })
      .then((h) => {
        resolved = true;
        return h;
      });

    await flush();
    expect(transport.totalStreamCount).toBe(1);
    expect(resolved).toBe(false);

    transport.resolveReady(0);
    await pending;
    expect(resolved).toBe(true);

    await thread.close();
  });

  it("serializes rotations across ticks (never 3 streams open)", async () => {
    const transport = new MockSseTransport({ manualReady: true });
    const thread = new ThreadStream(transport, { assistantId: "a" });

    const p1 = thread.subscribe({ channels: ["messages"] });
    await flush();
    expect(transport.totalStreamCount).toBe(1);

    // Cross-tick subscribe lands while rotation 1 is still waiting on
    // `ready`. It must wait — not open a second stream in parallel.
    const p2 = thread.subscribe({ channels: ["tools"] });
    await flush();
    expect(transport.totalStreamCount).toBe(1);

    transport.resolveReady(0);
    await p1;

    // After the first rotation lands, the second rotation kicks off
    // (either because `desired` has changed, or the scheduled reconcile
    // runs). At no point should three streams be open concurrently.
    await flush();
    transport.resolveReady(1);
    await p2;

    expect(transport.activeStreamCount).toBe(1);
    expect(transport.totalStreamCount).toBeLessThanOrEqual(2);

    await thread.close();
  });

  it("rejects the triggering subscribe when openEventStream.ready fails", async () => {
    const transport = new MockSseTransport({ manualReady: true });
    const thread = new ThreadStream(transport, { assistantId: "a" });

    const failing = thread.subscribe({ channels: ["messages"] });
    await flush();
    transport.rejectReady(0, new Error("server refused"));

    await expect(failing).rejects.toThrow("server refused");
    // The failed stream is closed; no active stream remains.
    expect(transport.activeStreamCount).toBe(0);

    await thread.close();
  });

  it("keeps existing stream alive when a subsequent rotation fails", async () => {
    const transport = new MockSseTransport({ manualReady: true });
    const thread = new ThreadStream(transport, { assistantId: "a" });

    const subA = thread.subscribe({ channels: ["messages"] });
    await flush();
    transport.resolveReady(0);
    const a = await subA;

    transport.pushEvent(
      eventOf(
        "messages",
        { event: "message-start", id: "msg_1" } as never,
        { namespace: [], seq: 1, eventId: "evt_a" }
      )
    );
    await nextValue(a);

    const failingSub = thread
      .subscribe({ channels: ["tools"] })
      .catch((err) => err);
    await flush();
    expect(transport.totalStreamCount).toBe(2);
    transport.rejectReady(1, new Error("transient"));

    const err = await failingSub;
    expect((err as Error).message).toBe("transient");

    // Sub `a` is still usable: the original stream is still running.
    transport.pushEvent(
      eventOf(
        "messages",
        { event: "message-start", id: "msg_2" } as never,
        { namespace: [], seq: 2, eventId: "evt_b" }
      )
    );
    const nxt = await nextValue(a);
    expect((nxt as { event_id?: string }).event_id).toBe("evt_b");

    await thread.close();
  });

  it("close() during rotation rejects pending subscribes and cleans up", async () => {
    const transport = new MockSseTransport({ manualReady: true });
    const thread = new ThreadStream(transport, { assistantId: "a" });

    const pending = thread.subscribe({ channels: ["messages"] });
    await flush();
    expect(transport.totalStreamCount).toBe(1);

    await thread.close();
    await expect(pending).rejects.toThrow(/closed/i);
  });

  it("pauses all non-lifecycle subscriptions on a terminal lifecycle event", async () => {
    const transport = new MockSseTransport();
    const thread = new ThreadStream(transport, { assistantId: "a" });

    const messages = await thread.subscribe({ channels: ["messages"] });
    const tools = await thread.subscribe({ channels: ["tools"] });

    await thread.run.start({ input: {} });

    transport.pushEvent(
      eventOf(
        "lifecycle",
        { event: "completed" } as never,
        { namespace: [], seq: 1, eventId: "evt_done" }
      )
    );
    await flush();
    await flush();

    expect(messages.isPaused).toBe(true);
    expect(tools.isPaused).toBe(true);

    await thread.close();
  });

  it("delivers trailing custom events emitted immediately after terminal lifecycle", async () => {
    const transport = new MockSseTransport();
    const thread = new ThreadStream(transport, { assistantId: "a" });

    const custom = await thread.subscribe({ channels: ["custom"] });

    await thread.run.start({ input: {} });

    transport.pushEvent(
      eventOf(
        "lifecycle",
        { event: "completed" } as never,
        { namespace: [], seq: 1, eventId: "evt_done" }
      )
    );
    transport.pushEvent(
      eventOf(
        "custom",
        { name: "a2a", payload: { status: "finished" } } as never,
        { namespace: [], seq: 2, eventId: "evt_a2a_done" }
      )
    );

    expect(await nextValue(custom)).toMatchObject({
      method: "custom",
      params: { data: { name: "a2a", payload: { status: "finished" } } },
    });

    await flush();
    await flush();
    expect(custom.isPaused).toBe(true);

    await thread.close();
  });

  it("dispatches a single event to multiple subs with different filters", async () => {
    const transport = new MockSseTransport();
    const thread = new ThreadStream(transport, { assistantId: "a" });

    const wide = await thread.subscribe({ channels: ["messages"] });
    const narrow = await thread.subscribe({
      channels: ["messages"],
      namespaces: [["agent_1"]],
    });

    // Client-side filtering: only `wide` should see this event.
    transport.pushEvent(
      eventOf(
        "messages",
        { event: "message-start", id: "m_outside" } as never,
        { namespace: ["other"], seq: 1, eventId: "evt_outside" }
      )
    );

    // Both should see this event.
    transport.pushEvent(
      eventOf(
        "messages",
        { event: "message-start", id: "m_inside" } as never,
        { namespace: ["agent_1"], seq: 2, eventId: "evt_inside" }
      )
    );

    const got1 = await nextValue(wide);
    const got2 = await nextValue(wide);
    expect(got1).toMatchObject({ event_id: "evt_outside" });
    expect(got2).toMatchObject({ event_id: "evt_inside" });

    const narrowed = await nextValue(narrow);
    expect(narrowed).toMatchObject({ event_id: "evt_inside" });

    await thread.close();
  });
});

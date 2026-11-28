import { afterEach, describe, expect, it, vi } from "vitest";
import type { Client } from "../client.js";
import { followThread } from "./thread-watcher.js";

type Connection = { event: string; data: unknown; id?: string }[] | Error;

function clientWith(connections: Connection[]) {
  const joinStream = vi.fn(
    (_threadId: string, _options: { lastEventId?: string }) => {
      const next = connections.shift() ?? [];
      return (async function* () {
        if (next instanceof Error) throw next;
        yield* next;
      })();
    }
  );
  return {
    client: { threads: { joinStream } } as unknown as Client,
    lastEventIds: () =>
      joinStream.mock.calls.map(([, options]) => options.lastEventId),
  };
}

const httpError = (status: number) =>
  Object.assign(new Error(`HTTP ${status}`), { status });

describe("followThread", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reopens a stream the server ended, from the last event id", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const events: string[] = [];
    const { client, lastEventIds } = clientWith([
      [
        { id: "1-0", event: "metadata", data: { run_id: "r1" } },
        { event: "interrupts", data: { run_id: "r1" } },
      ],
      [{ id: "2-0", event: "metadata", data: { run_id: "r2" } }],
      httpError(404),
    ]);

    const followed = followThread(
      client,
      "t1",
      {},
      (event) => events.push(event),
      controller.signal
    );
    await vi.runAllTimersAsync();

    await expect(followed).resolves.toBe("unsupported");
    expect(lastEventIds()).toEqual([undefined, "1-0", "2-0"]);
    expect(events).toEqual(["metadata", "interrupts", "metadata"]);
  });

  it.each([
    { error: httpError(404), end: "unsupported" },
    { error: httpError(403), end: "refused" },
    { error: httpError(422), end: "refused" },
    { error: httpError(503), end: "failed" },
    { error: new TypeError("fetch failed"), end: "failed" },
  ])("ends $end on $error.message", async ({ error, end }) => {
    const { client } = clientWith([error]);

    await expect(
      followThread(client, "t1", {}, () => {}, new AbortController().signal)
    ).resolves.toBe(end);
  });

  it("fails after five reopened streams in a row end without an event", async () => {
    vi.useFakeTimers();
    const { client, lastEventIds } = clientWith([]);

    const followed = followThread(
      client,
      "t1",
      { lastEventId: "9-0" },
      () => {},
      new AbortController().signal
    );
    await vi.runAllTimersAsync();

    await expect(followed).resolves.toBe("failed");
    expect(lastEventIds()).toEqual(Array(6).fill("9-0"));
  });

  it("ends at once when the signal aborts during the reconnect wait", async () => {
    const controller = new AbortController();
    const { client, lastEventIds } = clientWith([[]]);

    const followed = followThread(
      client,
      "t1",
      {},
      () => {},
      controller.signal
    );
    await vi.waitFor(() => expect(lastEventIds()).toHaveLength(1));
    controller.abort();

    await expect(followed).resolves.toBe("aborted");
    expect(lastEventIds()).toHaveLength(1);
  });
});

import { describe, expect, it, vi } from "vitest";

import { EMPTY_QUEUE, type SubmissionQueueSnapshot } from "./queue-adapter.js";
import { LocalQueueAdapter } from "./queue-adapter-local.js";
import { StreamStore } from "./store.js";

interface State {
  count?: number;
}

function makeStore(): StreamStore<SubmissionQueueSnapshot<State>> {
  return new StreamStore<SubmissionQueueSnapshot<State>>(
    EMPTY_QUEUE as SubmissionQueueSnapshot<State>
  );
}

describe("LocalQueueAdapter", () => {
  it("enqueue is purely local, never touches the network", async () => {
    const store = makeStore();
    const onError = vi.fn();
    const adapter = new LocalQueueAdapter<State>(store, onError);

    await adapter.enqueue("thread-1", { count: 1 }, undefined);

    expect(store.getSnapshot()).toHaveLength(1);
    expect(store.getSnapshot()[0].values).toEqual({ count: 1 });
    expect(store.getSnapshot()[0].runId).toBeUndefined();
  });

  it("onIdle drains the head and strips multitaskStrategy so it can't recursively re-enqueue", () => {
    const store = makeStore();
    const onError = vi.fn();
    const adapter = new LocalQueueAdapter<State>(store, onError);
    store.setState(() => [
      {
        id: "a",
        values: { count: 1 },
        options: { multitaskStrategy: "enqueue" },
        createdAt: new Date(),
      },
    ]);

    const dispatch = vi.fn(async () => undefined);
    adapter.onIdle(dispatch);

    expect(store.getSnapshot()).toHaveLength(0);
    expect(dispatch).toHaveBeenCalledWith(
      { count: 1 },
      expect.objectContaining({ multitaskStrategy: undefined })
    );
  });

  it("routes a failed drain through onError instead of an unhandled rejection", async () => {
    const store = makeStore();
    const onError = vi.fn();
    const adapter = new LocalQueueAdapter<State>(store, onError);
    store.setState(() => [
      { id: "a", values: { count: 1 }, createdAt: new Date() },
    ]);

    const boom = new Error("dispatch failed");
    adapter.onIdle(vi.fn(async () => {
      throw boom;
    }));

    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(boom));
  });
});

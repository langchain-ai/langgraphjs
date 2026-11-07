import { describe, it, expect, vi } from "vitest";
import { emptyCheckpoint } from "@langchain/langgraph-checkpoint";
import { RedisSaver } from "../index.js";

// `put()` keeps `checkpoint_head:<thread>` pointing at each namespace's newest
// checkpoint, and `getTuple()` without an id reads that checkpoint by key.
// These cases need no Redis; head-pointer.int.test.ts runs the Lua script.

const doc = (id: string) => ({
  thread_id: "t",
  checkpoint_ns: "__empty__",
  checkpoint_id: id,
  parent_checkpoint_id: null,
  checkpoint: { ...emptyCheckpoint(), id },
  metadata: {},
  checkpoint_ts: 1,
  has_writes: "false",
});

const makeMockClient = (
  options: { head?: string; docs?: string[]; evalError?: Error } = {}
) => {
  const docs = new Map(
    (options.docs ?? []).map((id) => [`checkpoint:t::${id}`, doc(id)])
  );
  const client = {
    keys: vi.fn(async () => [...docs.keys()]),
    hGet: vi.fn(async () => options.head ?? null),
    hDel: vi.fn(async () => 1),
    eval: vi.fn(async (_script: string, _options: unknown) => {
      if (options.evalError) throw options.evalError;
      return 1;
    }),
    exists: async () => 0,
    expire: async () => true,
    json: {
      get: vi.fn(async (key: string) => docs.get(key) ?? null),
      set: async () => "OK",
    },
    ft: { create: async () => {} },
  };
  return client;
};

const config = { configurable: { thread_id: "t", checkpoint_ns: "" } };

describe("RedisSaver head pointer", () => {
  it("reads the checkpoint the pointer names, without KEYS", async () => {
    const client = makeMockClient({ head: "c2", docs: ["c1", "c2", "c3"] });
    const saver = new RedisSaver(client as never);

    const tuple = await saver.getTuple(config);

    expect(tuple?.config.configurable?.checkpoint_id).toBe("c2");
    expect(client.hGet).toHaveBeenCalledWith("checkpoint_head:t", "");
    expect(client.keys).not.toHaveBeenCalled();
  });

  it("falls back to KEYS without a pointer and points it at the latest checkpoint", async () => {
    const client = makeMockClient({ docs: ["c1", "c3", "c2"] });
    const saver = new RedisSaver(client as never);

    const tuple = await saver.getTuple(config);

    expect(tuple?.config.configurable?.checkpoint_id).toBe("c3");
    expect(client.keys).toHaveBeenCalledWith("checkpoint:t::*");
    expect(client.eval).toHaveBeenCalledWith(expect.any(String), {
      keys: ["checkpoint_head:t"],
      arguments: ["", "c3", "", "1"],
    });
  });

  it("replaces a pointer to a checkpoint that is gone", async () => {
    const client = makeMockClient({ head: "c9", docs: ["c1"] });
    const saver = new RedisSaver(client as never);

    const tuple = await saver.getTuple(config);

    expect(tuple?.config.configurable?.checkpoint_id).toBe("c1");
    expect(client.eval).toHaveBeenCalledWith(expect.any(String), {
      keys: ["checkpoint_head:t"],
      arguments: ["", "c1", "c9", "1"],
    });
  });

  it("moves the pointer on put, and lets only a thread's first checkpoint set a missing one", async () => {
    const client = makeMockClient();
    const saver = new RedisSaver(client as never);

    // LangGraph's first checkpoint of a thread: the run's input.
    await saver.put(
      config,
      { ...emptyCheckpoint(), id: "c1" },
      { source: "input", step: -1, parents: {} },
      {}
    );
    await saver.put(
      { configurable: { ...config.configurable, checkpoint_id: "c1" } },
      { ...emptyCheckpoint(), id: "c2" },
      { source: "loop", step: 0, parents: {} },
      {}
    );
    // A write with no parent that is not a first checkpoint.
    await saver.put(
      config,
      { ...emptyCheckpoint(), id: "c1" },
      {} as never,
      {}
    );

    expect(client.eval.mock.calls.map(([, options]) => options)).toEqual([
      { keys: ["checkpoint_head:t"], arguments: ["", "c1", "", "1"] },
      { keys: ["checkpoint_head:t"], arguments: ["", "c2", "", "0"] },
      { keys: ["checkpoint_head:t"], arguments: ["", "c1", "", "0"] },
    ]);
  });

  it("removes the pointer when moving it fails, and the put still succeeds", async () => {
    const client = makeMockClient({ evalError: new Error("NOSCRIPT") });
    const saver = new RedisSaver(client as never);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const written = await saver.put(
      config,
      { ...emptyCheckpoint(), id: "c1" },
      { source: "loop", step: 0, parents: {} },
      {}
    );

    expect(written.configurable?.checkpoint_id).toBe("c1");
    expect(client.hDel).toHaveBeenCalledWith("checkpoint_head:t", "");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

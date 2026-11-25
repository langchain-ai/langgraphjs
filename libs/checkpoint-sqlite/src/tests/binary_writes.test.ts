import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { emptyCheckpoint, TASKS } from "@langchain/langgraph-checkpoint";
import { SqliteSaver } from "../index.js";

describe("SqliteSaver binary writes", () => {
  it.each([
    new Uint8Array([0, 255, 128, 195, 40]),
    new Uint8Array(),
  ])("preserves pending bytes in direct reads and history: %s", async (bytes) => {
    const saver = SqliteSaver.fromConnString(":memory:");
    try {
      const config = await saver.put(
        { configurable: { thread_id: "bytes" } },
        emptyCheckpoint(),
        { source: "input", step: -1, parents: {} }
      );
      await saver.putWrites(config, [["result", bytes]], "task");
      expect((await saver.getTuple(config))?.pendingWrites).toEqual([
        ["task", "result", bytes],
      ]);
      const history = [];
      for await (const tuple of saver.list(config)) history.push(tuple);
      expect(history[0].pendingWrites).toEqual([["task", "result", bytes]]);
    } finally {
      saver.db.close();
    }
  });

  it("preserves custom binary serialization when migrating legacy sends", async () => {
    const saver = new SqliteSaver(new Database(":memory:"), {
      async dumpsTyped(value) {
        const json = new TextEncoder().encode(JSON.stringify(value));
        return ["binary-json", new Uint8Array([255, ...json])];
      },
      async loadsTyped(_type, value) {
        expect(value).toBeInstanceOf(Uint8Array);
        expect(value[0]).toBe(255);
        return JSON.parse(new TextDecoder().decode((value as Uint8Array).slice(1)));
      },
    });
    try {
      const parent = await saver.put(
        { configurable: { thread_id: "legacy" } },
        emptyCheckpoint(),
        { source: "input", step: -1, parents: {} }
      );
      const send = { node: "worker", args: { value: 42 } };
      await saver.putWrites(parent, [[TASKS, send]], "task");
      const child = await saver.put(
        parent,
        { ...emptyCheckpoint(), v: 3 },
        { source: "loop", step: 0, parents: {} }
      );
      expect((await saver.getTuple(child))?.checkpoint.channel_values[TASKS]).toEqual([send]);
      const history = [];
      for await (const tuple of saver.list(child)) history.push(tuple);
      expect(history[0].checkpoint.channel_values[TASKS]).toEqual([send]);
    } finally {
      saver.db.close();
    }
  });
});

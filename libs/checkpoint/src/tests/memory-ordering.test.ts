import { describe, expect, it } from "vitest";
import { emptyCheckpoint, type CheckpointTuple } from "../base.js";
import { uuid6 } from "../id.js";
import { MemorySaver } from "../memory.js";

describe.each([
  { name: "custom IDs", ids: ["A", "Z", "a"] },
  { name: "UUID6 IDs", ids: [uuid6(0), uuid6(0), uuid6(0)] },
])("MemorySaver checkpoint ordering with $name", ({ ids }) => {
  it.each(["", "child:task"])(
    "uses descending code-unit order in namespace %j",
    async (checkpoint_ns) => {
      const saver = new MemorySaver();
      const config = { configurable: { thread_id: "ordering", checkpoint_ns } };
      for (const index of [1, 2, 0]) {
        const savedConfig = await saver.put(
          {
            configurable: {
              ...config.configurable,
              checkpoint_id: ids[index - 1],
            },
          },
          {
            ...emptyCheckpoint(),
            id: ids[index],
            channel_values: { messages: ids[index] },
          },
          { source: "update", step: index, parents: {} }
        );
        await saver.putWrites(savedConfig, [["messages", ids[index]]], "task");
      }

      expect.soft((await saver.getTuple(config))?.checkpoint.id).toBe(ids[2]);
      expect
        .soft(
          (await saver.getTuple({
            configurable: { ...config.configurable, checkpoint_id: ids[1] },
          }))?.checkpoint.id
        )
        .toBe(ids[1]);

      const tuples: CheckpointTuple[] = [];
      for await (const tuple of saver.list(config)) tuples.push(tuple);
      expect.soft(tuples.map((tuple) => tuple.checkpoint.id)).toEqual([
        ids[2],
        ids[1],
        ids[0],
      ]);

      const before: CheckpointTuple[] = [];
      for await (const tuple of saver.list(config, {
        before: {
          configurable: { ...config.configurable, checkpoint_id: ids[1] },
        },
      })) {
        before.push(tuple);
      }
      expect.soft(before.map((tuple) => tuple.checkpoint.id)).toEqual([ids[0]]);

      const history = await saver.getDeltaChannelHistory({
        config,
        channels: ["messages"],
      });
      expect.soft(history.messages).toEqual({
        seed: ids[1],
        writes: [["task", "messages", ids[1]]],
      });
    }
  );
});

import { describe, expect, it } from "vitest";
import { emptyCheckpoint } from "../base.js";
import type { CheckpointMetadata } from "../types.js";
import type { SerializerProtocol } from "../serde/base.js";
import { JsonPlusSerializer } from "../serde/jsonplus.js";
import { MemorySaver } from "../memory.js";
import { TASKS } from "../serde/types.js";

const metadata: CheckpointMetadata = { source: "loop", step: 0, parents: {} };
const initialConfig = {
  configurable: { thread_id: "types", checkpoint_ns: "" },
};

class TaggedSerializer implements SerializerProtocol {
  private json = new JsonPlusSerializer();
  async dumpsTyped(value: unknown): Promise<[string, Uint8Array]> {
    const kind =
      value && typeof value === "object" && "id" in value
        ? "checkpoint"
        : value && typeof value === "object" && "source" in value
          ? "metadata"
          : "write";
    const [, data] = await this.json.dumpsTyped({ kind, value });
    return [kind, data];
  }
  async loadsTyped(type: string, data: Uint8Array | string): Promise<unknown> {
    if (!["checkpoint", "metadata", "write"].includes(type))
      throw new Error(`Unexpected serialization type ${type}`);
    const decoded = await this.json.loadsTyped("json", data);
    if (decoded.kind !== type)
      throw new Error(`Mismatched serialization type ${type}`);
    return decoded.value;
  }
}

describe("MemorySaver serializer types", () => {
  it.each([new Uint8Array([0, 255]), new TextEncoder().encode("123")])(
    "round-trips pending bytes without parsing them as JSON",
    async (bytes) => {
      const saver = new MemorySaver();
      const config = await saver.put(
        initialConfig,
        { ...emptyCheckpoint(), id: "001" },
        metadata
      );
      await saver.putWrites(config, [["data", bytes]], "task");
      const tuple = await saver.getTuple(config);
      expect(tuple?.pendingWrites).toEqual([["task", "data", bytes]]);
      const listed = [];
      for await (const item of saver.list(initialConfig)) listed.push(item);
      expect(listed[0].pendingWrites).toEqual([["task", "data", bytes]]);
      const child = await saver.put(
        config,
        { ...emptyCheckpoint(), id: "002" },
        metadata
      );
      expect(
        (
          await saver.getDeltaChannelHistory({
            config: child,
            channels: ["data"],
          })
        ).data.writes
      ).toEqual([["task", "data", bytes]]);
    }
  );
  it("preserves checkpoint, metadata and write tags across all read paths", async () => {
    const saver = new MemorySaver(new TaggedSerializer());
    const checkpoint = {
      ...emptyCheckpoint(),
      id: "001",
      channel_values: { data: "seed" },
    };
    const config = await saver.put(initialConfig, checkpoint, metadata);
    await saver.putWrites(config, [["data", "update"]], "task");
    for (const lookup of [config, initialConfig]) {
      const tuple = await saver.getTuple(lookup);
      expect(tuple?.checkpoint).toEqual(checkpoint);
      expect(tuple?.metadata).toEqual(metadata);
      expect(tuple?.pendingWrites).toEqual([["task", "data", "update"]]);
    }
    const listed = [];
    for await (const tuple of saver.list(initialConfig)) listed.push(tuple);
    expect(listed[0].checkpoint).toEqual(checkpoint);
    expect(listed[0].metadata).toEqual(metadata);
    const child = await saver.put(
      config,
      { ...emptyCheckpoint(), id: "002" },
      metadata
    );
    expect(
      await saver.getDeltaChannelHistory({ config: child, channels: ["data"] })
    ).toEqual({ data: { seed: "seed", writes: [["task", "data", "update"]] } });
  });
  it("reads persisted checkpoint tuples without appended type tags", async () => {
    const saver = new MemorySaver();
    const serde = new JsonPlusSerializer();
    const checkpoint = { ...emptyCheckpoint(), id: "legacy" };
    const [, checkpointData] = await serde.dumpsTyped(checkpoint);
    const [, metadataData] = await serde.dumpsTyped(metadata);
    saver.storage.types = {
      "": { legacy: [checkpointData, metadataData, undefined] },
    };
    const tuple = await saver.getTuple(initialConfig);
    expect(tuple?.checkpoint).toEqual(checkpoint);
    expect(tuple?.metadata).toEqual(metadata);
    const listed = [];
    for await (const item of saver.list(initialConfig)) listed.push(item);
    expect(listed[0].checkpoint).toEqual(checkpoint);
    expect(listed[0].metadata).toEqual(metadata);
  });
  it("uses saved write tags when migrating legacy pending sends", async () => {
    const saver = new MemorySaver(new TaggedSerializer());
    const config = await saver.put(
      initialConfig,
      { ...emptyCheckpoint(), id: "001" },
      metadata
    );
    const send = { node: "worker", args: { value: 1 } };
    await saver.putWrites(config, [[TASKS, send]], "task");
    const child = await saver.put(
      config,
      { ...emptyCheckpoint(), id: "002", v: 3 },
      metadata
    );
    expect(
      (await saver.getTuple(child))?.checkpoint.channel_values[TASKS]
    ).toEqual([send]);
  });
});

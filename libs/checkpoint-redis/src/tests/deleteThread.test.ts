import { describe, it, expect } from "vitest";
import { RedisSaver } from "../index.js";

describe("RedisSaver.deleteThread", () => {
  it("deletes checkpoints, writes, and zset keys using correct patterns", async () => {
    const deletedKeys: string[] = [];

    const mockClient = {
      keys: async (pattern: string) => {
        if (pattern === "checkpoint:thread-1:*") {
          return ["checkpoint:thread-1:cp-1", "checkpoint:thread-1:cp-2"];
        }
        if (pattern === "checkpoint_write:thread-1:*") {
          return [
            "checkpoint_write:thread-1::cp-1:task-1:0",
            "checkpoint_write:thread-1::cp-1:task-1:1",
          ];
        }
        if (pattern === "write_keys_zset:thread-1:*") {
          return ["write_keys_zset:thread-1::cp-1"];
        }
        return [];
      },
      del: async (keys: string[]) => {
        deletedKeys.push(...keys);
        return keys.length;
      },
    } as any;

    const saver = new RedisSaver(mockClient);
    await saver.deleteThread("thread-1");

    expect(deletedKeys).toEqual(
      expect.arrayContaining([
        "checkpoint:thread-1:cp-1",
        "checkpoint:thread-1:cp-2",
        "checkpoint_write:thread-1::cp-1:task-1:0",
        "checkpoint_write:thread-1::cp-1:task-1:1",
        "write_keys_zset:thread-1::cp-1",
      ])
    );
    expect(deletedKeys).toHaveLength(5);
  });

  it("handles empty key sets gracefully", async () => {
    const deletedKeys: string[] = [];

    const mockClient = {
      keys: async () => [],
      del: async (keys: string[]) => {
        deletedKeys.push(...keys);
        return keys.length;
      },
    } as any;

    const saver = new RedisSaver(mockClient);
    await saver.deleteThread("nonexistent-thread");

    expect(deletedKeys).toHaveLength(0);
  });
});

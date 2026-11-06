import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemorySaver } from "../src/storage/checkpoint.mjs";

describe("InMemorySaver restart with typed write records", () => {
  it("keeps pending bytes after copying a thread and restarting", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lg-api-typed-restart-"));
    const saver = new InMemorySaver();
    const persistence = await saver.initialize(cwd);
    try {
      const bytes = new Uint8Array([0, 255, 128]);
      const config = await saver.put(
        { configurable: { thread_id: "thread-a", checkpoint_ns: "" } },
        {
          v: 4,
          id: "checkpoint",
          ts: "2026-01-01T00:00:00.000Z",
          channel_values: {},
          channel_versions: {},
          versions_seen: {},
        },
        { source: "loop", step: 0, parents: {} }
      );
      await saver.putWrites(config, [["data", bytes]], "task", "path");
      await saver.copy("thread-a", "thread-b");
      await persistence.flush();

      const restarted = new InMemorySaver();
      await restarted.initialize(cwd);
      for (const threadId of ["thread-a", "thread-b"]) {
        const tuple = await restarted.getTuple({
          configurable: { thread_id: threadId, checkpoint_ns: "" },
        });
        expect(tuple?.checkpoint.id).toBe("checkpoint");
        expect(tuple?.metadata?.source).toBe("loop");
        expect(tuple?.pendingWrites).toEqual([["task", "data", bytes]]);
      }
    } finally {
      await persistence.flush();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

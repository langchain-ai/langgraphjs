import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { getStaticGraphSchema } from "../src/graph/parser/index.mjs";

describe("getStaticGraphSchema", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("clears its timeout when the worker fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "langgraph-parser-"));
    try {
      const sourceFile = join(dir, "graph.mts");
      writeFileSync(sourceFile, "export const notTheGraph = 1;\n");
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

      await expect(
        getStaticGraphSchema(
          { sourceFile, exportSymbol: "graph" },
          { timeoutMs: 120_000 }
        )
      ).rejects.toThrow('Failed to find export "graph"');

      // A timer left armed keeps the process alive until it fires.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

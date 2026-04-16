import { describe } from "vitest";
import { specTest } from "@langchain/langgraph-checkpoint-validation";
import { IncrementalSqliteSaver } from "../index.js";
import { BetterSqliteBackend } from "../backends/better-sqlite3.js";

// Test 1: Blob-only mode (no list channels)
// All channel values go through checkpoint_blobs
describe("blob-only mode", () => {
  specTest({
    checkpointerName:
      "@langchain/langgraph-checkpoint-sqlite-incremental (blob-only)",
    createCheckpointer() {
      const backend = BetterSqliteBackend.fromConnString(":memory:");
      return new IncrementalSqliteSaver(backend);
    },
    destroyCheckpointer(saver: IncrementalSqliteSaver) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((saver as any).backend as BetterSqliteBackend).close();
    },
  });
});

// Test 2: Segments mode (animals channel treated as a list)
// The validation tests use animals: ["dog"] -> ["dog", "fish"] which exercises append
describe("segments mode", () => {
  specTest({
    checkpointerName:
      "@langchain/langgraph-checkpoint-sqlite-incremental (segments)",
    createCheckpointer() {
      const backend = BetterSqliteBackend.fromConnString(":memory:");
      return new IncrementalSqliteSaver(backend, {
        listChannels: new Set(["animals"]),
      });
    },
    destroyCheckpointer(saver: IncrementalSqliteSaver) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((saver as any).backend as BetterSqliteBackend).close();
    },
  });
});

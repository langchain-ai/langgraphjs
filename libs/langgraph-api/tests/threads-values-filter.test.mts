import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSystemPersistence } from "../src/storage/persist.mjs";
import { FileSystemOps } from "../src/storage/ops.mjs";
import type { Store } from "../src/storage/types.mjs";

const HAS_VALUES = "11111111-1111-1111-1111-111111111111";
const HAS_OTHER_VALUES = "22222222-2222-2222-2222-222222222222";
const NEVER_RUN = "33333333-3333-3333-3333-333333333333";

/**
 * `threads.put` creates a thread with `values: undefined`: it has no state until
 * a run writes one. A `values` filter must not match such a thread unless the
 * filter is empty.
 */
describe("threads.search / threads.count `values` filter", () => {
  let cwd: string;
  let conn: FileSystemPersistence<Store>;
  let ops: FileSystemOps;

  beforeEach(async () => {
    cwd = mkdtempSync(join(tmpdir(), "lg-api-values-filter-"));
    conn = new FileSystemPersistence<Store>(".langgraphjs_ops.json", () => ({
      runs: {},
      threads: {},
      assistants: {},
      assistant_versions: [],
      retry_counter: {},
    }));
    await conn.initialize(cwd);
    ops = new FileSystemOps(conn);

    for (const [threadId, name] of [
      [HAS_VALUES, "has-values"],
      [HAS_OTHER_VALUES, "has-other-values"],
      [NEVER_RUN, "never-run"],
    ]) {
      await ops.threads.put(
        threadId,
        { metadata: { name }, if_exists: "raise" },
        undefined
      );
    }

    await conn.with((store) => {
      store.threads[HAS_VALUES].values = { topic: "cats" };
      store.threads[HAS_OTHER_VALUES].values = { topic: "dogs" };
    });
  });

  afterEach(async () => {
    await conn.flush();
    rmSync(cwd, { recursive: true, force: true });
  });

  const search = async (values: Record<string, unknown>) => {
    const names: string[] = [];
    for await (const { thread } of ops.threads.search(
      { values, limit: 10, offset: 0 },
      undefined
    )) {
      names.push(String(thread.metadata?.name));
    }
    return names.sort();
  };

  const count = (values: Record<string, unknown>) =>
    ops.threads.count({ values }, undefined);

  it("search: a never-run thread does not match a non-empty values filter", async () => {
    expect(await search({ topic: "cats" })).toEqual(["has-values"]);
    expect(await search({ topic: "dogs" })).toEqual(["has-other-values"]);
  });

  it("search: a values filter nothing matches returns no threads", async () => {
    expect(await search({ topic: "birds" })).toEqual([]);
  });

  it("search: an empty values filter still matches every thread", async () => {
    expect(await search({})).toEqual([
      "has-other-values",
      "has-values",
      "never-run",
    ]);
  });

  it("count: a never-run thread does not match a non-empty values filter", async () => {
    expect(await count({ topic: "cats" })).toBe(1);
    expect(await count({ topic: "dogs" })).toBe(1);
    expect(await count({ topic: "birds" })).toBe(0);
  });

  it("count: an empty values filter still matches every thread", async () => {
    expect(await count({})).toBe(3);
  });
});

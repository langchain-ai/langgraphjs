/* eslint-disable no-process-env */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import pg, { type QueryConfig } from "pg";
import { emptyCheckpoint } from "@langchain/langgraph-checkpoint";
import { PostgresSaver } from "../index.js";

const { TEST_POSTGRES_URL } = process.env;
if (!TEST_POSTGRES_URL) {
  throw new Error("TEST_POSTGRES_URL environment variable is required");
}

type QueryPlan = {
  "Relation Name"?: string;
  "Index Name"?: string;
  "Index Cond"?: string;
  Plans?: QueryPlan[];
};

const planNodes = (plan: QueryPlan): QueryPlan[] => [
  plan,
  ...(plan.Plans ?? []).flatMap(planNodes),
];

describe("version-keyed checkpoint blob reads", () => {
  const schema = `blob_lookup_${randomUUID().replaceAll("-", "")}`;
  const pool = new pg.Pool({ connectionString: TEST_POSTGRES_URL });
  const saver = new PostgresSaver(pool, undefined, { schema });

  beforeAll(async () => {
    await saver.setup();
  });

  afterAll(async () => {
    try {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await pool.end();
    }
  });

  it("loads exact versions without scanning the thread's historical blobs", async () => {
    const config = {
      configurable: { thread_id: randomUUID(), checkpoint_ns: "" },
    };
    const saved: Awaited<ReturnType<PostgresSaver["put"]>>[] = [];
    for (const [version, value] of [
      ["first", "Original"],
      ["second", "Current"],
    ] as const) {
      const checkpoint = emptyCheckpoint();
      checkpoint.channel_values = { answer: value };
      checkpoint.channel_versions = { answer: version };
      saved.push(
        await saver.put(
          config,
          checkpoint,
          { source: "loop", step: saved.length, parents: {} },
          checkpoint.channel_versions
        )
      );
    }
    await saver.putWrites(
      saved[1],
      [["marker", "Pending result"]],
      "task-result"
    );
    const [type, blob] = await saver.serde.dumpsTyped("Unreferenced history");
    await pool.query(
      `INSERT INTO "${schema}".checkpoint_blobs
       (thread_id,checkpoint_ns,channel,version,type,blob)
       SELECT $1,'','answer','historical-'||n,$2,$3
       FROM generate_series(1,1024) n`,
      [config.configurable.thread_id, type, Buffer.from(blob)]
    );
    await pool.query(`ANALYZE "${schema}".checkpoint_blobs`);

    const observed = vi.spyOn(pool, "query");
    expect((await saver.getTuple(config))?.checkpoint.channel_values).toEqual({
      answer: "Current",
    });
    expect((await saver.getTuple(saved[0]))?.checkpoint.channel_values).toEqual({
      answer: "Original",
    });
    const listed = [];
    for await (const tuple of saver.list(config, { limit: 1 })) {
      listed.push(tuple);
    }
    expect(listed).toHaveLength(1);
    expect(listed[0].checkpoint.channel_values).toEqual({ answer: "Current" });
    expect(listed[0].pendingWrites).toEqual([
      ["task-result", "marker", "Pending result"],
    ]);
    const statements = observed.mock.calls
      .map(([query]) => query as unknown as QueryConfig)
      .filter(
        (query) =>
          typeof query?.text === "string" &&
          query.text.includes("as channel_values")
      );
    observed.mockRestore();
    expect(statements).toHaveLength(3);
    for (const statement of statements) {
      // Plan the actual native getTuple/list query without running it again.
      const explained = await pool.query(
        `EXPLAIN (FORMAT JSON) ${statement.text}`,
        statement.values
      );
      const lookup = planNodes(explained.rows[0]["QUERY PLAN"][0].Plan).find(
        (plan) => plan["Relation Name"] === "checkpoint_blobs"
      );
      expect(lookup?.["Index Name"]).toBe("checkpoint_blobs_pkey");
      for (const key of ["thread_id", "checkpoint_ns", "channel", "version"]) {
        expect(lookup?.["Index Cond"]).toContain(key);
      }
    }
  });
});

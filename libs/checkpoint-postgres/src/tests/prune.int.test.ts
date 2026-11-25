/* eslint-disable no-process-env */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import type {
  ChannelVersions,
  CheckpointMetadata,
} from "@langchain/langgraph-checkpoint";
import { emptyCheckpoint, TASKS, uuid6 } from "@langchain/langgraph-checkpoint";
import type { RunnableConfig } from "@langchain/core/runnables";
import pg from "pg";
import { PostgresSaver } from "../index.js";
import { getPruneSQLStatements, getTablesWithSchema } from "../sql.js";

const { Pool } = pg;

const { TEST_POSTGRES_URL } = process.env;
if (!TEST_POSTGRES_URL) {
  throw new Error("TEST_POSTGRES_URL environment variable is required");
}

const SQL = getPruneSQLStatements("public");

type Rows = {
  checkpoints: [string, string][];
  writes: [string, string][];
  blobs: [string, string, string][];
};

const EMPTY_ROWS: Rows = { checkpoints: [], writes: [], blobs: [] };

describe("PostgresSaver.prune", () => {
  const dbName = `lg_prune_db_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const baseUrl = TEST_POSTGRES_URL.split("/").slice(0, -1).join("/");
  const dbUrl = `${baseUrl}/${dbName}`;
  const savers: PostgresSaver[] = [];
  let saver: PostgresSaver;
  let pool: pg.Pool;

  const newSaver = (schema = "public") => {
    const created = PostgresSaver.fromConnString(dbUrl, { schema });
    savers.push(created);
    return created;
  };

  beforeAll(async () => {
    const admin = new Pool({ connectionString: TEST_POSTGRES_URL });
    try {
      await admin.query(`CREATE DATABASE ${dbName}`);
    } finally {
      await admin.end();
    }
    saver = newSaver();
    await saver.setup();
    pool = new Pool({ connectionString: dbUrl });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await pool.end();
    await Promise.all(savers.map((s) => s.end()));
    const admin = new Pool({ connectionString: TEST_POSTGRES_URL });
    try {
      await admin.query(`DROP DATABASE ${dbName} WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  });

  const rowsOf = async (threadId: string, schema = "public"): Promise<Rows> => {
    const tables = getTablesWithSchema(schema);
    const select = async (sql: string) =>
      (
        await pool.query<Record<string, string>>(sql, [threadId])
      ).rows.map((row) => Object.values(row));
    return {
      checkpoints: (await select(
        `SELECT checkpoint_ns, checkpoint_id FROM ${tables.checkpoints} WHERE thread_id = $1 ORDER BY 1, 2`
      )) as Rows["checkpoints"],
      writes: (await select(
        `SELECT checkpoint_ns, checkpoint_id FROM ${tables.checkpoint_writes} WHERE thread_id = $1 ORDER BY 1, 2, task_id, idx`
      )) as Rows["writes"],
      blobs: (await select(
        `SELECT checkpoint_ns, channel, version FROM ${tables.checkpoint_blobs} WHERE thread_id = $1 ORDER BY 1, 2, 3`
      )) as Rows["blobs"],
    };
  };

  type PutOptions = {
    ns?: string;
    metadata?: Record<string, unknown>;
    v?: number;
    checkpointId?: string;
    target?: PostgresSaver;
  };

  const put = async (
    threadId: string,
    parent: RunnableConfig | undefined,
    step: number,
    values: Record<string, unknown>,
    versions: ChannelVersions,
    options: PutOptions = {}
  ): Promise<RunnableConfig> => {
    const config: RunnableConfig = {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: options.ns ?? "",
        ...(parent && {
          checkpoint_id: parent.configurable?.checkpoint_id,
        }),
      },
    };
    const checkpoint = emptyCheckpoint();
    checkpoint.v = options.v ?? 4;
    checkpoint.id = options.checkpointId ?? uuid6(step);
    checkpoint.channel_values = values;
    checkpoint.channel_versions = versions;
    const newVersions = Object.fromEntries(
      Object.keys(values).map((key) => [key, versions[key]])
    );
    return (options.target ?? saver).put(
      config,
      checkpoint,
      {
        source: "loop",
        step,
        parents: {},
        ...options.metadata,
      } as CheckpointMetadata,
      newVersions
    );
  };

  const putWrites = (
    config: RunnableConfig,
    writes: [string, unknown][],
    target: PostgresSaver = saver
  ) => target.putWrites(config, writes, crypto.randomUUID());

  const threeCheckpoints = async (
    threadId: string,
    options: Pick<PutOptions, "ns" | "metadata"> = {}
  ) => {
    let parent: RunnableConfig | undefined;
    const steps: [Record<string, unknown>, ChannelVersions][] = [
      [{ a: [1], s: ["shared"] }, { a: "1", s: "1" }],
      [{ a: [1, 2] }, { a: "2", s: "1" }],
      [{ a: [1, 2, 3] }, { a: "3", s: "1" }],
    ];
    for (const [step, [values, versions]] of steps.entries()) {
      parent = await put(threadId, parent, step, values, versions, options);
      await putWrites(parent, [["a", step]]);
    }
    return parent as RunnableConfig;
  };

  const idOf = (config: RunnableConfig) =>
    config.configurable?.checkpoint_id as string;

  const newThread = () => crypto.randomUUID();

  /** A thread a DeltaChannel has written, by the evidence it leaves. */
  const deltaThread = async (
    threadId: string,
    evidence: "counters" | "snapshot" | "versioned"
  ) => {
    if (evidence === "counters") {
      const first = await put(threadId, undefined, 0, { m: [1] }, { m: "1" });
      await put(
        threadId,
        first,
        1,
        {},
        { m: "2" },
        { metadata: { counters_since_delta_snapshot: { m: [1, 1] } } }
      );
    } else if (evidence === "snapshot") {
      // A snapshot is an inline `true` with a blob behind it, as langgraph
      // (Python) saves it; LangGraph.js inlines no values.
      const first = await put(threadId, undefined, 0, { m: [1] }, { m: "1" });
      await pool.query(
        `UPDATE checkpoints SET checkpoint = jsonb_set(checkpoint, '{channel_values}', '{"m": true}') WHERE thread_id = $1`,
        [threadId]
      );
      await put(threadId, first, 1, {}, { m: "2" });
    } else {
      const metadata = { delta_writes_versioned: true };
      const first = await put(
        threadId,
        undefined,
        0,
        { m: [1] },
        { m: "1" },
        { metadata }
      );
      await put(threadId, first, 1, { m: [1, 2] }, { m: "2" }, { metadata });
    }
  };

  /**
   * Runs `action` once the `nth` run of `sql` finishes, on the pool's own
   * queries and on those of the clients it hands out.
   */
  const runOnceAfter = (
    target: PostgresSaver,
    sql: string,
    action: () => Promise<void>,
    nth = 1
  ) => {
    const targetPool = target["pool"];
    let seen = 0;
    const after = async (text: unknown) => {
      if (text === sql && ++seen === nth) await action();
    };
    const query = targetPool.query.bind(targetPool) as (
      ...args: unknown[]
    ) => Promise<unknown>;
    vi.spyOn(targetPool, "query").mockImplementation((async (
      ...args: unknown[]
    ) => {
      const result = await query(...args);
      await after(args[0]);
      return result;
    }) as never);
    const connect = targetPool.connect.bind(targetPool) as (
      callback?: unknown
    ) => Promise<pg.PoolClient>;
    vi.spyOn(targetPool, "connect").mockImplementation((async (
      callback?: unknown
    ) => {
      // `pool.query` connects with a callback and is hooked above.
      if (callback) return connect(callback);
      const client = await connect();
      return new Proxy(client, {
        get(clientTarget, prop) {
          const value = Reflect.get(clientTarget, prop);
          if (prop !== "query") {
            return typeof value === "function"
              ? value.bind(clientTarget)
              : value;
          }
          return async (...args: unknown[]) => {
            const result = await (value as (...a: unknown[]) => unknown).apply(
              clientTarget,
              args
            );
            await after(args[0]);
            return result;
          };
        },
      });
    }) as never);
  };

  it("keeps each namespace's head with its writes and blobs", async () => {
    const threadId = newThread();
    const otherId = newThread();
    const heads: Record<string, RunnableConfig> = {};
    for (const ns of ["", "sub:1"]) {
      heads[ns] = await threeCheckpoints(threadId, { ns });
    }
    await threeCheckpoints(otherId);
    const before = {
      "": await saver.getTuple(heads[""]),
      "sub:1": await saver.getTuple(heads["sub:1"]),
    };
    const otherBefore = await rowsOf(otherId);

    await saver.prune([threadId]);

    const rows = await rowsOf(threadId);
    expect(rows.checkpoints).toEqual(
      ["", "sub:1"].map((ns) => [ns, idOf(heads[ns])])
    );
    expect(new Set(rows.writes.map(([ns, id]) => `${ns}/${id}`))).toEqual(
      new Set(rows.checkpoints.map(([ns, id]) => `${ns}/${id}`))
    );
    expect(rows.blobs).toEqual(
      ["", "sub:1"].flatMap((ns) => [
        [ns, "a", "3"],
        [ns, "s", "1"],
      ])
    );
    for (const ns of ["", "sub:1"] as const) {
      expect(await saver.getTuple(heads[ns])).toEqual({
        ...before[ns],
        parentConfig: undefined,
      });
    }
    expect(await rowsOf(otherId)).toEqual(otherBefore);
  });

  it("keeps the latest checkpoint by default and with an empty options object", async () => {
    const [first, second] = [newThread(), newThread()];
    const firstHead = await threeCheckpoints(first);
    const secondHead = await threeCheckpoints(second);

    await saver.prune([first]);
    await saver.prune([second], { strategy: "keep_latest" });

    expect((await rowsOf(first)).checkpoints).toEqual([["", idOf(firstHead)]]);
    expect((await rowsOf(second)).checkpoints).toEqual([
      ["", idOf(secondHead)],
    ]);
  });

  it("prunes the schema the saver was given", async () => {
    const schema = "prune_custom_schema";
    const custom = newSaver(schema);
    await custom.setup();
    const threadId = newThread();
    let parent: RunnableConfig | undefined;
    for (let step = 0; step < 3; step += 1) {
      parent = await put(
        threadId,
        parent,
        step,
        { a: [step] },
        { a: String(step + 1) },
        { target: custom }
      );
    }

    await custom.prune([threadId]);

    expect(await rowsOf(threadId, schema)).toEqual({
      checkpoints: [["", idOf(parent as RunnableConfig)]],
      writes: [],
      blobs: [["", "a", "3"]],
    });
  });

  it.each(["counters", "snapshot", "versioned"] as const)(
    "refuses a batch with a DeltaChannel thread (%s)",
    async (evidence) => {
      const [ordinaryId, deltaId] = [newThread(), newThread()];
      await threeCheckpoints(ordinaryId);
      await deltaThread(deltaId, evidence);
      const before = [await rowsOf(ordinaryId), await rowsOf(deltaId)];

      await expect(saver.prune([ordinaryId, deltaId])).rejects.toThrow(
        deltaId
      );

      expect([await rowsOf(ordinaryId), await rowsOf(deltaId)]).toEqual(before);
    }
  );

  it("prunes a thread storing a plain true", async () => {
    const threadId = newThread();
    const first = await put(threadId, undefined, 0, { a: [1] }, { a: "1" });
    const head = await put(threadId, first, 1, {}, { flag: "2", a: "1" });
    // A plain `true` value is inlined with no blob behind it, as langgraph
    // (Python) saves it.
    await pool.query(
      `UPDATE checkpoints SET checkpoint = jsonb_set(checkpoint, '{channel_values}', '{"flag": true}') WHERE thread_id = $1`,
      [threadId]
    );

    await saver.prune([threadId]);

    expect((await rowsOf(threadId)).checkpoints).toEqual([["", idOf(head)]]);
  });

  it("keeps the parent holding a pre-v4 head's sends", async () => {
    const threadId = newThread();
    const first = await put(threadId, undefined, 0, {}, {}, { v: 1 });
    await putWrites(first, [[TASKS, "send-1"]]);
    const second = await put(threadId, first, 1, {}, {}, { v: 1 });
    const head = await put(threadId, second, 2, {}, {}, { v: 1 });
    await putWrites(second, [[TASKS, "send-2"]]);

    await saver.prune([threadId]);

    expect((await rowsOf(threadId)).checkpoints).toEqual([
      ["", idOf(second)],
      ["", idOf(head)],
    ]);
    const loaded = await saver.getTuple(head);
    expect(loaded?.checkpoint.channel_values[TASKS]).toEqual(["send-2"]);
    expect(idOf(loaded?.parentConfig as RunnableConfig)).toBe(idOf(second));
    expect((await saver.getTuple(second))?.parentConfig).toBeUndefined();
  });

  it("deletes every row of the threads with the delete strategy", async () => {
    const [ordinaryId, deltaId, otherId] = [
      newThread(),
      newThread(),
      newThread(),
    ];
    await threeCheckpoints(ordinaryId);
    await deltaThread(deltaId, "counters");
    await threeCheckpoints(otherId);
    const otherBefore = await rowsOf(otherId);

    await saver.prune([ordinaryId, deltaId], { strategy: "delete" });

    expect(await rowsOf(ordinaryId)).toEqual(EMPTY_ROWS);
    expect(await rowsOf(deltaId)).toEqual(EMPTY_ROWS);
    expect(await rowsOf(otherId)).toEqual(otherBefore);
  });

  it("changes nothing for an unknown strategy", async () => {
    const threadId = newThread();
    await threeCheckpoints(threadId);
    const before = await rowsOf(threadId);

    await expect(
      saver.prune([threadId], { strategy: "keep_all" as never })
    ).rejects.toThrow("keep_all");

    expect(await rowsOf(threadId)).toEqual(before);
  });

  it("changes nothing for an empty list", async () => {
    const threadId = newThread();
    await threeCheckpoints(threadId);
    const before = await rowsOf(threadId);

    await saver.prune([]);
    await saver.prune([], { strategy: "delete" });

    expect(await rowsOf(threadId)).toEqual(before);
  });

  it.each(["keep_latest", "delete"] as const)(
    "rejects a single thread id string with %s",
    async (strategy) => {
      const ids = ["ab", "a", "b"].map((id) => `${newThread()}-${id}`);
      for (const id of ids) await threeCheckpoints(id);
      const before = await Promise.all(ids.map((id) => rowsOf(id)));

      await expect(
        saver.prune(ids[0] as unknown as string[], { strategy })
      ).rejects.toThrow(TypeError);

      expect(await Promise.all(ids.map((id) => rowsOf(id)))).toEqual(before);
    }
  );

  it.each([
    ["heads", SQL.HEADS_SQL],
    ["blobs", SQL.REFERENCED_BLOBS_SQL],
  ])(
    "keeps a checkpoint saved while it runs (after the %s read)",
    async (_name, after) => {
      const threadId = newThread();
      const head = await threeCheckpoints(threadId);
      const other = newSaver();
      const saved: RunnableConfig[] = [];
      runOnceAfter(saver, after, async () => {
        saved.push(
          await put(
            threadId,
            head,
            3,
            { a: [1, 2, 3, 4] },
            { a: "4", s: "1" },
            { target: other }
          )
        );
      });

      await saver.prune([threadId]);

      const loaded = await saver.getTuple(saved[0]);
      expect(loaded, "the checkpoint saved during the prune was deleted").toBeDefined();
      expect(loaded?.checkpoint.channel_values).toEqual({
        a: [1, 2, 3, 4],
        s: ["shared"],
      });
      expect(idOf(loaded?.parentConfig as RunnableConfig)).toBe(idOf(head));
    }
  );

  it("refuses a thread that turns DeltaChannel after the batch check", async () => {
    const threadId = newThread();
    const head = await threeCheckpoints(threadId);
    const other = newSaver();
    runOnceAfter(saver, SQL.DELTA_THREADS_SQL, async () => {
      await put(
        threadId,
        head,
        3,
        {},
        { a: "4", s: "1" },
        {
          target: other,
          metadata: { counters_since_delta_snapshot: { a: [1, 1] } },
        }
      );
    });

    await expect(saver.prune([threadId])).rejects.toThrow(threadId);

    expect((await rowsOf(threadId)).checkpoints).toHaveLength(4);
  });

  it("keeps the history of a DeltaChannel checkpoint saved after the thread check", async () => {
    const threadId = newThread();
    const head = await threeCheckpoints(threadId);
    const other = newSaver();
    const saved: RunnableConfig[] = [];
    runOnceAfter(
      saver,
      SQL.DELTA_THREADS_SQL,
      async () => {
        saved.push(
          await put(
            threadId,
            head,
            3,
            {},
            { a: "4", s: "1" },
            {
              target: other,
              metadata: { counters_since_delta_snapshot: { a: [1, 1] } },
            }
          )
        );
      },
      2
    );

    await saver.prune([threadId]);

    expect((await rowsOf(threadId)).checkpoints).toEqual([
      ["", idOf(head)],
      ["", idOf(saved[0])],
    ]);
    const history = await saver.getDeltaChannelHistory({
      config: saved[0],
      channels: ["a"],
    });
    expect(history.a.seed).toEqual([1, 2, 3]);
    expect(history.a.writes.map(([, , value]) => value)).toEqual([2]);
  });

  it("deletes a subgraph call with the checkpoint it started from", async () => {
    const threadId = newThread();
    const older = await put(threadId, undefined, 0, {}, {});
    const head = await put(threadId, older, 1, {}, {});
    const startedFrom: Record<string, string> = {
      "finished:1": idOf(older),
      "interrupted:2": idOf(head),
      "running:3": uuid6(2),
      checkpointer_true: idOf(older),
    };
    for (const [ns, root] of Object.entries(startedFrom)) {
      await threeCheckpoints(threadId, { ns, metadata: { parents: { "": root } } });
    }

    await saver.prune([threadId]);

    const rows = await rowsOf(threadId);
    const namespaces = (list: string[][]) => new Set(list.map(([ns]) => ns));
    expect(namespaces(rows.checkpoints)).toEqual(
      new Set(["", "interrupted:2", "running:3", "checkpointer_true"])
    );
    const subgraphs = new Set(["interrupted:2", "running:3", "checkpointer_true"]);
    expect(namespaces(rows.writes)).toEqual(subgraphs);
    expect(namespaces(rows.blobs)).toEqual(subgraphs);
  });

  it("keeps a checkpoint saved meanwhile, whatever its id", async () => {
    const threadId = newThread();
    const head = await threeCheckpoints(threadId);
    const lowerId = `0${idOf(head).slice(1)}`;
    const other = newSaver();
    const saved: RunnableConfig[] = [];
    runOnceAfter(saver, SQL.HEADS_SQL, async () => {
      const child = await put(
        threadId,
        head,
        3,
        { a: [1, 2, 3, 4] },
        { a: "4", s: "1" },
        { target: other, checkpointId: lowerId }
      );
      await putWrites(child, [["a", 4]], other);
      saved.push(child);
    });

    await saver.prune([threadId]);

    const loaded = await saver.getTuple(saved[0]);
    expect(loaded, "the checkpoint saved during the prune was deleted").toBeDefined();
    expect(loaded?.checkpoint.channel_values).toEqual({
      a: [1, 2, 3, 4],
      s: ["shared"],
    });
    expect(loaded?.pendingWrites?.map(([, , value]) => value)).toEqual([4]);
  });

  it("keeps writes saved before their checkpoint", async () => {
    const threadId = newThread();
    const head = await threeCheckpoints(threadId);
    const nextId = uuid6(3);
    const nextConfig: RunnableConfig = {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: "",
        checkpoint_id: nextId,
      },
    };
    await putWrites(nextConfig, [["a", 4]]);

    await saver.prune([threadId]);
    await put(threadId, head, 3, {}, { a: "3", s: "1" }, { checkpointId: nextId });

    const loaded = await saver.getTuple(nextConfig);
    expect(loaded?.pendingWrites?.map(([, , value]) => value)).toEqual([4]);
  });
});

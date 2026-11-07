/* eslint-disable no-process-env */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import type {
  Checkpoint,
  CheckpointMetadata,
  CheckpointTuple,
} from "@langchain/langgraph-checkpoint";
import {
  BaseCheckpointSaver,
  DeltaSnapshot,
  emptyCheckpoint,
  TASKS,
  uuid6,
} from "@langchain/langgraph-checkpoint";
import pg from "pg";
import { RunnableConfig } from "@langchain/core/runnables";
import { PostgresSaver } from "../index.js"; // Adjust the import path as needed
import { getMigrations } from "../migrations.js";
import { getTablesWithSchema } from "../sql.js";

const { Pool } = pg;

const checkpoint1: Checkpoint = {
  v: 1,
  id: uuid6(0),
  ts: "2024-04-19T17:19:07.952Z",
  channel_values: {
    someKey1: "someValue1",
  },
  channel_versions: {
    someKey1: 1,
    someKey2: 1,
  },
  versions_seen: {
    someKey3: {
      someKey4: 1,
    },
  },
  // @ts-expect-error - older version of checkpoint
  pending_sends: [],
};

const checkpoint2: Checkpoint = {
  v: 1,
  id: uuid6(1),
  ts: "2024-04-20T17:19:07.952Z",
  channel_values: {
    someKey1: "someValue2",
  },
  channel_versions: {
    someKey1: 1,
    someKey2: 2,
  },
  versions_seen: {
    someKey3: {
      someKey4: 2,
    },
  },
  // @ts-expect-error - older version of checkpoint
  pending_sends: [],
};

const { TEST_POSTGRES_URL } = process.env;
if (!TEST_POSTGRES_URL) {
  throw new Error("TEST_POSTGRES_URL environment variable is required");
}

let postgresSavers: PostgresSaver[] = [];

afterAll(async () => {
  await Promise.all(postgresSavers.map((saver) => saver.end()));
  // clear the ended savers to clean up for the next test
  postgresSavers = [];

  // Drop all test databases
  const pool = new Pool({ connectionString: TEST_POSTGRES_URL });

  try {
    const result = await pool.query(`
    SELECT datname FROM pg_database
    WHERE datname LIKE 'lg_test_db_%'
  `);

    for (const row of result.rows) {
      const dbName = row.datname;
      await pool.query(`DROP DATABASE ${dbName} WITH (FORCE)`);
      console.log(`🗑️  Dropped database: ${dbName}`);
    }
  } finally {
    await pool.end();
  }
}, 30_000);

describe.each([
  { schema: undefined, description: "the default schema" },
  { schema: "custom_schema", description: "a custom schema" },
  { schema: "custom-schema", description: "a schema with dashes" },
])("PostgresSaver with $description", ({ schema }) => {
  let postgresSaver: PostgresSaver;
  let currentDbConnectionString: string;

  beforeEach(async () => {
    const pool = new Pool({
      connectionString: TEST_POSTGRES_URL,
    });
    // Generate a unique database name
    const dbName = `lg_test_db_${Date.now()}_${Math.floor(
      Math.random() * 1000
    )}`;

    try {
      // Create a new database
      await pool.query(`CREATE DATABASE ${dbName}`);
      console.log(`✅ Created database: ${dbName}`);

      // Connect to the new database
      const dbConnectionString = `${TEST_POSTGRES_URL?.split("/")
        .slice(0, -1)
        .join("/")}/${dbName}`;
      currentDbConnectionString = dbConnectionString;
      postgresSaver = PostgresSaver.fromConnString(dbConnectionString, {
        schema,
      });
      postgresSavers.push(postgresSaver);
      await postgresSaver.setup();
    } finally {
      await pool.end();
    }
  });

  it("loads large blobs in checkpoints, writes, and legacy sends", async () => {
    const value = "\u0000" + "a".repeat(64_000_000) + "é";
    const checkpoint = emptyCheckpoint();
    checkpoint.v = 3;
    checkpoint.channel_values = {
      large: value,
      bytes: new Uint8Array([0, 92, 255]),
      nil: null,
    };
    checkpoint.channel_versions = { large: 1, bytes: 1, nil: 1, empty: 1 };
    const config = { configurable: { thread_id: uuid6(0), checkpoint_ns: "" } };
    const parent = await postgresSaver.put(
      config,
      checkpoint,
      { source: "input", step: 0, parents: {} },
      { large: 1, bytes: 1, nil: 1, empty: 1 }
    );
    await postgresSaver.putWrites(
      parent,
      [
        ["large", value],
        [TASKS, value],
      ],
      "task"
    );
    const child = emptyCheckpoint();
    child.v = 3;
    child.channel_versions = { large: 1 };
    const childConfig = await postgresSaver.put(
      parent,
      child,
      { source: "loop", step: 1, parents: {} },
      {}
    );
    const assertValue = (actual: unknown) => {
      expect(actual).toBe(value);
    };
    const loadedParent = await postgresSaver.getTuple(parent);
    assertValue(loadedParent?.checkpoint.channel_values.large);
    expect(
      Array.from(loadedParent?.checkpoint.channel_values.bytes as Uint8Array)
    ).toEqual([0, 92, 255]);
    expect(loadedParent?.checkpoint.channel_values.nil).toBeNull();
    expect(loadedParent?.checkpoint.channel_values).not.toHaveProperty("empty");
    assertValue(
      loadedParent?.pendingWrites?.find(
        ([, channel]) => channel === "large"
      )?.[2]
    );
    const loadedChild = await postgresSaver.getTuple(childConfig);
    assertValue(loadedChild?.checkpoint.channel_values.large);
    assertValue(
      (
        loadedChild?.checkpoint.channel_values[TASKS] as unknown[] | undefined
      )?.[0]
    );
    for await (const tuple of postgresSaver.list(config)) {
      assertValue(tuple.checkpoint.channel_values.large);
      if (tuple.checkpoint.id === child.id) {
        assertValue((tuple.checkpoint.channel_values[TASKS] as unknown[])[0]);
      } else {
        assertValue(
          tuple.pendingWrites?.find(([, channel]) => channel === "large")?.[2]
        );
      }
    }
  }, 120_000);

  it("should properly initialize and setup the database", async () => {
    // Verify that the database is properly initialized
    const pool = new Pool({
      connectionString: currentDbConnectionString,
    });
    const client = await pool.connect();
    const currentSchema = schema ?? "public";
    try {
      // Check if the schema exists
      const schemaResult = await client.query(
        `
        SELECT schema_name
        FROM information_schema.schemata
        WHERE schema_name = $1
      `,
        [currentSchema]
      );
      expect(schemaResult.rows.length).toBe(1);

      // Check if the required tables exist
      const tablesQuery = `
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = $1
        AND table_name IN ('checkpoints', 'checkpoint_blobs', 'checkpoint_writes', 'checkpoint_migrations')
      `;
      const tablesResult = await client.query(tablesQuery, [currentSchema]);
      expect(tablesResult.rows.length).toBe(4);

      // Verify table structures
      const checkpointsColumns = await client.query(
        `
        SELECT column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'checkpoints'
        ORDER BY ordinal_position
      `,
        [currentSchema]
      );

      expect(checkpointsColumns.rows).toEqual([
        {
          column_name: "thread_id",
          data_type: "text",
          is_nullable: "NO",
          column_default: null,
        },
        {
          column_name: "checkpoint_ns",
          data_type: "text",
          is_nullable: "NO",
          column_default: "''::text",
        },
        {
          column_name: "checkpoint_id",
          data_type: "text",
          is_nullable: "NO",
          column_default: null,
        },
        {
          column_name: "parent_checkpoint_id",
          data_type: "text",
          is_nullable: "YES",
          column_default: null,
        },
        {
          column_name: "type",
          data_type: "text",
          is_nullable: "YES",
          column_default: null,
        },
        {
          column_name: "checkpoint",
          data_type: "jsonb",
          is_nullable: "NO",
          column_default: null,
        },
        {
          column_name: "metadata",
          data_type: "jsonb",
          is_nullable: "NO",
          column_default: "'{}'::jsonb",
        },
      ]);

      const checkpointBlobsColumns = await client.query(
        `
        SELECT column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'checkpoint_blobs'
        ORDER BY ordinal_position
      `,
        [currentSchema]
      );

      expect(checkpointBlobsColumns.rows).toEqual([
        {
          column_name: "thread_id",
          data_type: "text",
          is_nullable: "NO",
          column_default: null,
        },
        {
          column_name: "checkpoint_ns",
          data_type: "text",
          is_nullable: "NO",
          column_default: "''::text",
        },
        {
          column_name: "channel",
          data_type: "text",
          is_nullable: "NO",
          column_default: null,
        },
        {
          column_name: "version",
          data_type: "text",
          is_nullable: "NO",
          column_default: null,
        },
        {
          column_name: "type",
          data_type: "text",
          is_nullable: "NO",
          column_default: null,
        },
        {
          column_name: "blob",
          data_type: "bytea",
          is_nullable: "YES",
          column_default: null,
        },
      ]);

      const checkpointWritesColumns = await client.query(
        `
        SELECT column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'checkpoint_writes'
        ORDER BY ordinal_position
      `,
        [currentSchema]
      );

      expect(checkpointWritesColumns.rows).toEqual([
        {
          column_name: "thread_id",
          data_type: "text",
          is_nullable: "NO",
          column_default: null,
        },
        {
          column_name: "checkpoint_ns",
          data_type: "text",
          is_nullable: "NO",
          column_default: "''::text",
        },
        {
          column_name: "checkpoint_id",
          data_type: "text",
          is_nullable: "NO",
          column_default: null,
        },
        {
          column_name: "task_id",
          data_type: "text",
          is_nullable: "NO",
          column_default: null,
        },
        {
          column_name: "idx",
          data_type: "integer",
          is_nullable: "NO",
          column_default: null,
        },
        {
          column_name: "channel",
          data_type: "text",
          is_nullable: "NO",
          column_default: null,
        },
        {
          column_name: "type",
          data_type: "text",
          is_nullable: "YES",
          column_default: null,
        },
        {
          column_name: "blob",
          data_type: "bytea",
          is_nullable: "NO",
          column_default: null,
        },
        {
          column_name: "task_path",
          data_type: "text",
          is_nullable: "NO",
          column_default: "''::text",
        },
      ]);

      // Verify migrations table has correct number of entries
      const migrationsResult = await client.query(`
        SELECT COUNT(*) as count
        FROM ${schema ? `"${schema}".` : ""}checkpoint_migrations
      `);
      const MIGRATIONS = getMigrations(currentSchema);
      expect(Number.parseInt(migrationsResult.rows[0].count, 10)).toBe(
        MIGRATIONS.length
      );
    } finally {
      client.release();
      await pool.end();
    }
  });

  it("should save and retrieve checkpoints correctly", async () => {
    // get undefined checkpoint
    const undefinedCheckpoint = await postgresSaver.getTuple({
      configurable: { thread_id: "1" },
    });
    expect(undefinedCheckpoint).toBeUndefined();

    // save first checkpoint
    const runnableConfig = await postgresSaver.put(
      { configurable: { thread_id: "1" } },
      checkpoint1,
      { source: "update", step: -1, parents: {} },
      checkpoint1.channel_versions
    );
    expect(runnableConfig).toEqual({
      configurable: {
        thread_id: "1",
        checkpoint_ns: "",
        checkpoint_id: checkpoint1.id,
      },
    });

    // add some writes
    await postgresSaver.putWrites(
      {
        configurable: {
          checkpoint_id: checkpoint1.id,
          checkpoint_ns: "",
          thread_id: "1",
        },
      },
      [["bar", "baz"]],
      "foo"
    );

    // get first checkpoint tuple
    const firstCheckpointTuple = await postgresSaver.getTuple({
      configurable: { thread_id: "1" },
    });
    expect(firstCheckpointTuple?.config).toEqual({
      configurable: {
        thread_id: "1",
        checkpoint_ns: "",
        checkpoint_id: checkpoint1.id,
      },
    });
    expect(firstCheckpointTuple?.checkpoint).toEqual(checkpoint1);
    expect(firstCheckpointTuple?.metadata).toEqual({
      source: "update",
      step: -1,
      parents: {},
    });
    expect(firstCheckpointTuple?.parentConfig).toBeUndefined();
    expect(firstCheckpointTuple?.pendingWrites).toEqual([
      ["foo", "bar", "baz"],
    ]);

    // save second checkpoint
    await postgresSaver.put(
      {
        configurable: {
          thread_id: "1",
          checkpoint_id: "2024-04-18T17:19:07.952Z",
        },
      },
      checkpoint2,
      { source: "update", step: -1, parents: {} },
      checkpoint2.channel_versions
    );

    // verify that parentTs is set and retrieved correctly for second checkpoint
    const secondCheckpointTuple = await postgresSaver.getTuple({
      configurable: { thread_id: "1" },
    });
    expect(secondCheckpointTuple?.metadata).toEqual({
      source: "update",
      step: -1,
      parents: {},
    });
    expect(secondCheckpointTuple?.parentConfig).toEqual({
      configurable: {
        thread_id: "1",
        checkpoint_ns: "",
        checkpoint_id: "2024-04-18T17:19:07.952Z",
      },
    });

    // list checkpoints
    const checkpointTupleGenerator = postgresSaver.list({
      configurable: { thread_id: "1" },
    });
    const checkpointTuples: CheckpointTuple[] = [];
    for await (const checkpoint of checkpointTupleGenerator) {
      checkpointTuples.push(checkpoint);
    }
    expect(checkpointTuples.length).toBe(2);
    const checkpointTuple1 = checkpointTuples[0];
    const checkpointTuple2 = checkpointTuples[1];
    expect(checkpointTuple1.checkpoint.ts).toBe("2024-04-20T17:19:07.952Z");
    expect(checkpointTuple2.checkpoint.ts).toBe("2024-04-19T17:19:07.952Z");
  });

  it("keeps each branch's value when two checkpoints from one parent write the same channel", async () => {
    const parentConfig = await postgresSaver.put(
      { configurable: { thread_id: "branches" } },
      {
        ...emptyCheckpoint(),
        id: uuid6(0),
        channel_values: { ch: "base" },
        channel_versions: { ch: 1 },
      },
      { source: "loop", step: 0, parents: {} },
      { ch: 1 }
    );
    const branch = async (value: string, step: number) => {
      const version = postgresSaver.getNextVersion(1);
      return postgresSaver.put(
        parentConfig,
        {
          ...emptyCheckpoint(),
          id: uuid6(step),
          channel_values: { ch: value },
          channel_versions: { ch: version },
        },
        { source: "update", step: 1, parents: {} },
        { ch: version }
      );
    };

    const first = await branch("first", 1);
    const second = await branch("second", 2);

    expect(
      (await postgresSaver.getTuple(first))?.checkpoint.channel_values
    ).toEqual({ ch: "first" });
    expect(
      (await postgresSaver.getTuple(second))?.checkpoint.channel_values
    ).toEqual({ ch: "second" });
  });

  it("throws on a string version, as the base saver does", () => {
    expect(() =>
      postgresSaver.getNextVersion("00000000000000000000000000000001.0.5" as never)
    ).toThrow("Please override this method to use string versions.");
  });

  it("should delete thread", async () => {
    const thread1 = { configurable: { thread_id: "1", checkpoint_ns: "" } };
    const thread2 = { configurable: { thread_id: "2", checkpoint_ns: "" } };

    const meta: CheckpointMetadata = {
      source: "update",
      step: -1,
      parents: {},
    };

    await postgresSaver.put(thread1, emptyCheckpoint(), meta, {});
    await postgresSaver.put(thread2, emptyCheckpoint(), meta, {});

    expect(await postgresSaver.getTuple(thread1)).toBeDefined();

    await postgresSaver.deleteThread("1");

    expect(await postgresSaver.getTuple(thread1)).toBeUndefined();
    expect(await postgresSaver.getTuple(thread2)).toBeDefined();
  });

  it("pending sends migration", async () => {
    let config: RunnableConfig = {
      configurable: { thread_id: "thread-1", checkpoint_ns: "" },
    };

    const checkpoint0: Checkpoint = {
      v: 1,
      id: uuid6(0),
      ts: "2024-04-19T17:19:07.952Z",
      channel_values: {},
      channel_versions: {},
      versions_seen: {},
    };

    config = await postgresSaver.put(
      config,
      checkpoint0,
      { source: "loop", parents: {}, step: 0 },
      {}
    );

    await postgresSaver.putWrites(
      config,
      [
        [TASKS, "send-1"],
        [TASKS, "send-2"],
      ],
      "task-1"
    );
    await postgresSaver.putWrites(config, [[TASKS, "send-3"]], "task-2");

    // check that fetching checkpount 0 doesn't attach pending sends
    // (they should be attached to the next checkpoint)
    const tuple0 = await postgresSaver.getTuple(config);
    expect(tuple0?.checkpoint.channel_values).toEqual({});
    expect(tuple0?.checkpoint.channel_versions).toEqual({});

    // create second checkpoint
    const checkpoint1: Checkpoint = {
      v: 1,
      id: uuid6(1),
      ts: "2024-04-20T17:19:07.952Z",
      channel_values: {},
      channel_versions: checkpoint0.channel_versions,
      versions_seen: checkpoint0.versions_seen,
      // @ts-expect-error - older version of checkpoint
      pending_sends: [],
    };

    config = await postgresSaver.put(
      config,
      checkpoint1,
      { source: "loop", parents: {}, step: 1 },
      {}
    );

    // check that pending sends are attached to checkpoint1
    const checkpoint1Tuple = await postgresSaver.getTuple(config);
    expect(checkpoint1Tuple?.checkpoint.channel_values).toEqual({
      [TASKS]: ["send-1", "send-2", "send-3"],
    });
    expect(checkpoint1Tuple?.checkpoint.channel_versions[TASKS]).toBeDefined();

    // check that the list also applies the migration
    const checkpointTupleGenerator = postgresSaver.list({
      configurable: { thread_id: "thread-1" },
    });
    const checkpointTuples: CheckpointTuple[] = [];
    for await (const checkpoint of checkpointTupleGenerator) {
      checkpointTuples.push(checkpoint);
    }
    expect(checkpointTuples.length).toBe(2);
    expect(checkpointTuples[0].checkpoint.channel_values).toEqual({
      [TASKS]: ["send-1", "send-2", "send-3"],
    });
    expect(
      checkpointTuples[0].checkpoint.channel_versions[TASKS]
    ).toBeDefined();
  });

  it("should JSON.stringify when referenced from runnable configurable", () => {
    expect(() =>
      JSON.stringify({
        configurable: { __pregel_checkpointer: postgresSaver },
      })
    ).not.toThrow();
    expect(
      JSON.stringify({
        configurable: { __pregel_checkpointer: postgresSaver },
      })
    ).toContain("[PostgresSaver]");
  });

  it("should default missing versions_seen when loading a checkpoint", async () => {
    const threadId = "missing-versions-seen";
    const checkpointId = uuid6(3);
    const pool = new Pool({ connectionString: currentDbConnectionString });
    const tables = getTablesWithSchema(schema ?? "public");
    try {
      await pool.query(
        `INSERT INTO ${tables.checkpoints}
          (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, checkpoint, metadata)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          threadId,
          "",
          checkpointId,
          null,
          {
            v: 4,
            id: checkpointId,
            ts: new Date().toISOString(),
            channel_versions: { messages: 1 },
          },
          { source: "input", step: 0, parents: {} },
        ]
      );

      const tuple = await postgresSaver.getTuple({
        configurable: { thread_id: threadId },
      });

      expect(tuple?.checkpoint.versions_seen).toEqual({});
      expect(tuple?.checkpoint.channel_versions).toEqual({ messages: 1 });
    } finally {
      await pool.end();
    }
  });

  describe("getDeltaChannelHistory", () => {
    type ChannelPlan = {
      stores: (step: number) => boolean;
      writes: (step: number) => boolean;
      /** The stored value, a DeltaSnapshot when absent. */
      value?: unknown;
    };

    // A channel's version moves when it was written the step before or
    // stores a value now, as a running DeltaChannel's does, so most steps
    // leave Postgres an "empty" blob row and an unwritten channel keeps
    // pointing at its last version.
    async function writeThread(
      saver: PostgresSaver,
      steps: number,
      plans: Record<string, ChannelPlan>
    ): Promise<RunnableConfig[]> {
      const channels = Object.keys(plans);
      const versions: Record<string, number> = {};
      const configs: RunnableConfig[] = [];
      let config: RunnableConfig = {
        configurable: { thread_id: uuid6(0), checkpoint_ns: "" },
      };
      for (let step = 0; step < steps; step += 1) {
        const changed = channels.filter(
          (ch) =>
            step === 0 || plans[ch].writes(step - 1) || plans[ch].stores(step)
        );
        for (const ch of changed) versions[ch] = (versions[ch] ?? 0) + 1;
        const newVersions = Object.fromEntries(
          changed.map((ch) => [ch, versions[ch]])
        );
        const values = Object.fromEntries(
          channels
            .filter((ch) => plans[ch].stores(step))
            .map((ch) => [
              ch,
              "value" in plans[ch]
                ? plans[ch].value
                : new DeltaSnapshot([`${ch} at ${step}`]),
            ])
        );
        config = await saver.put(
          config,
          {
            ...emptyCheckpoint(),
            id: uuid6(step),
            channel_values: values,
            channel_versions: { ...versions },
          },
          { source: "loop", step, parents: {} },
          newVersions
        );
        const writes = channels
          .filter((ch) => plans[ch].writes(step))
          .map((ch): [string, unknown] => [ch, `${ch} ${step}`]);
        if (writes.length > 0) {
          await saver.putWrites(config, writes, `task-${step}`);
        }
        configs.push(config);
      }
      return configs;
    }

    async function countingSaver() {
      const pool = new Pool({ connectionString: currentDbConnectionString });
      const saver = new PostgresSaver(pool, undefined, { schema });
      postgresSavers.push(saver);
      return { saver, queries: vi.spyOn(pool, "query") };
    }

    const baseWalk = (
      saver: PostgresSaver,
      args: Parameters<PostgresSaver["getDeltaChannelHistory"]>[0]
    ) => BaseCheckpointSaver.prototype.getDeltaChannelHistory.call(saver, args);

    it("loads a delta channel's history in the same number of queries at any depth", async () => {
      const { saver, queries } = await countingSaver();
      const queriesAt = async (depth: number) => {
        const configs = await writeThread(saver, depth + 1, {
          messages: { stores: (step) => step === 0, writes: () => true },
        });
        const args = { config: configs[depth], channels: ["messages"] };
        queries.mockClear();
        const history = await saver.getDeltaChannelHistory(args);
        const count = queries.mock.calls.length;
        expect(history.messages.writes).toHaveLength(depth);
        expect(history).toStrictEqual(await baseWalk(saver, args));
        return count;
      };

      expect([await queriesAt(5), await queriesAt(50)]).toEqual([2, 2]);
    });

    it("matches the base walk across pages of checkpoints", async () => {
      const { saver } = await countingSaver();
      const configs = await writeThread(saver, 1100, {
        messages: { stores: (step) => step === 0, writes: () => true },
        files: { stores: (step) => step % 100 === 0, writes: () => true },
        todos: { stores: () => false, writes: (step) => step % 250 === 0 },
        settings: {
          stores: (step) => step === 3,
          writes: () => false,
          value: null,
        },
        unused: { stores: () => false, writes: () => false },
      });
      const channels = ["messages", "files", "todos", "settings", "unused"];

      for (const config of [configs[1099], configs[1060], configs[40]]) {
        const args = { config, channels };
        const history = await saver.getDeltaChannelHistory(args);
        expect(history).toStrictEqual(await baseWalk(saver, args));
      }
      const latest = await saver.getDeltaChannelHistory({
        config: { configurable: { thread_id: configs[0].configurable?.thread_id } },
        channels,
      });
      expect(latest.messages.writes).toHaveLength(1099);
      expect(latest.settings).toStrictEqual({ writes: [], seed: null });
      expect(latest.todos).toEqual({
        writes: [0, 250, 500, 750, 1000].map((step) => [
          `task-${step}`,
          "todos",
          `todos ${step}`,
        ]),
      });
    }, 120_000);

    it("rejects parent links that form a cycle", async () => {
      const { saver } = await countingSaver();
      const thread_id = uuid6(0);
      const [a, b] = [uuid6(0), uuid6(0)];
      const at = (checkpoint_id: string): RunnableConfig => ({
        configurable: { thread_id, checkpoint_ns: "", checkpoint_id },
      });
      for (const [id, parent] of [
        [a, b],
        [b, a],
      ]) {
        await saver.put(
          at(parent),
          { ...emptyCheckpoint(), id },
          { source: "loop", step: 0, parents: {} },
          {}
        );
      }

      await expect(
        saver.getDeltaChannelHistory({ config: at(a), channels: ["messages"] })
      ).rejects.toThrow(`Checkpoint ${b} is its own ancestor`);
    });

    it("matches the base walk on a parent loop that reaches a stored value", async () => {
      const { saver } = await countingSaver();
      const thread_id = uuid6(0);
      const [a, b] = [uuid6(0), uuid6(0)];
      const at = (checkpoint_id: string): RunnableConfig => ({
        configurable: { thread_id, checkpoint_ns: "", checkpoint_id },
      });
      for (const [id, parent] of [
        [a, b],
        [b, a],
      ]) {
        const stores = id === a;
        const versions: Record<string, number> = stores ? { messages: 1 } : {};
        await saver.put(
          at(parent),
          {
            ...emptyCheckpoint(),
            id,
            channel_values: stores ? { messages: new DeltaSnapshot(["a"]) } : {},
            channel_versions: versions,
          },
          { source: "loop", step: 0, parents: {} },
          versions
        );
        await saver.putWrites(at(id), [["messages", `${id} write`]], id);
      }
      const args = { config: at(a), channels: ["messages"] };

      const history = await saver.getDeltaChannelHistory(args);

      expect(history).toStrictEqual(await baseWalk(saver, args));
      expect(history.messages.seed).toStrictEqual(new DeltaSnapshot(["a"]));
      expect(history.messages.writes.map((write) => write[2])).toEqual([
        `${a} write`,
        `${b} write`,
      ]);
    });
  });
});

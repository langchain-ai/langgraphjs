/* eslint-disable no-process-env */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import type {
  Checkpoint,
  CheckpointMetadata,
  CheckpointTuple,
} from "@langchain/langgraph-checkpoint";
import { emptyCheckpoint, TASKS, uuid6 } from "@langchain/langgraph-checkpoint";
import pg from "pg";
import { RunnableConfig } from "@langchain/core/runnables";
import { PostgresSaver } from "../index.js"; // Adjust the import path as needed
import { getMigrations } from "../migrations.js";

const { Pool } = pg;

const checkpoint1: Checkpoint = {
  v: 1,
  id: uuid6(-1),
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
      ]);

      // Verify migrations table has correct number of entries
      const migrationsResult = await client.query(`
        SELECT COUNT(*) as count
        FROM ${schema ? `${schema}.` : ""}checkpoint_migrations
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
});

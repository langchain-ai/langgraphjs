/* eslint-disable no-process-env */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import type {
  Checkpoint,
  CheckpointTuple,
} from "@langchain/langgraph-checkpoint";
import { uuid6 } from "@langchain/langgraph-checkpoint";
import { Sequelize } from "sequelize";
import { MySQLSaver } from "../index.js";

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
  pending_sends: [],
};

const { TEST_MYSQL_URL } = process.env;

if (!TEST_MYSQL_URL) {
  throw new Error("TEST_MYSQL_URL environment variable is required");
}
describe("MySQLSaver", () => {
  let testDbName: string;
  let mysqlSavers: MySQLSaver[] = [];
  let testDatabases: string[] = [];
  let mysqlSaver: MySQLSaver;
  let sequelize: Sequelize;

  beforeEach(async () => {
    // Generate a unique database name
    testDbName = `lg_test_db_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    testDatabases.push(testDbName);

    // Parse the base connection string to get connection info
    const url = new URL(TEST_MYSQL_URL);
    const baseConnectionString = `mysql://${url.username}:${url.password}@${
      url.hostname
    }:${url.port || "3306"}`;

    // Create base Sequelize instance to create database
    const baseSequelize = new Sequelize(baseConnectionString);

    try {
      // Create the test database
      await baseSequelize.query(`CREATE DATABASE IF NOT EXISTS ${testDbName}`);
      console.log(`✅ Created database: ${testDbName}`);
    } finally {
      await baseSequelize.close();
    }

    // Create connection string with the new database
    const dbConnectionString = `${baseConnectionString}/${testDbName}`;

    // Create Sequelize instance for the test database
    sequelize = new Sequelize(dbConnectionString);

    // Create MySQLSaver instance
    mysqlSaver = new MySQLSaver(sequelize);
    mysqlSavers.push(mysqlSaver);

    // Setup the database using MySQLSaver's setup method
    await mysqlSaver.setup();
  });

  afterAll(async () => {
    await Promise.all(mysqlSavers.map((saver) => saver.end()));
    // clear the ended savers to clean up for the next test
    mysqlSavers = [];

    // Drop all test databases
    const url = new URL(TEST_MYSQL_URL);
    const baseConnectionString = `mysql://${url.username}:${url.password}@${
      url.hostname
    }:${url.port || "3306"}`;
    const baseSequelize = new Sequelize(baseConnectionString);

    try {
      for (const dbName of testDatabases) {
        await baseSequelize.query(`DROP DATABASE IF EXISTS ${dbName}`);
        console.log(`🗑️  Dropped database: ${dbName}`);
      }
    } finally {
      await baseSequelize.close();
      testDatabases = [];
    }
  });

  it("should properly initialize and setup the database", async () => {
    // Verify that the database is properly initialized by checking if tables exist
    const [tablesResult] = await sequelize.query(`
      SELECT TABLE_NAME
      FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME IN ('checkpoints', 'checkpoint_blobs', 'checkpoint_writes', 'checkpoint_migrations')
    `);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((tablesResult as any[]).length).toBe(4);

    // Verify table structures
    const [checkpointsColumns] = await sequelize.query(`
      SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'checkpoints'
      ORDER BY ORDINAL_POSITION
    `);

    expect(checkpointsColumns).toEqual([
      {
        COLUMN_NAME: "thread_id",
        DATA_TYPE: "varchar",
        IS_NULLABLE: "NO",
        COLUMN_DEFAULT: null,
      },
      {
        COLUMN_NAME: "checkpoint_ns",
        DATA_TYPE: "varchar",
        IS_NULLABLE: "NO",
        COLUMN_DEFAULT: "",
      },
      {
        COLUMN_NAME: "checkpoint_id",
        DATA_TYPE: "varchar",
        IS_NULLABLE: "NO",
        COLUMN_DEFAULT: null,
      },
      {
        COLUMN_NAME: "parent_checkpoint_id",
        DATA_TYPE: "varchar",
        IS_NULLABLE: "YES",
        COLUMN_DEFAULT: null,
      },
      {
        COLUMN_NAME: "type",
        DATA_TYPE: "varchar",
        IS_NULLABLE: "YES",
        COLUMN_DEFAULT: null,
      },
      {
        COLUMN_NAME: "checkpoint",
        DATA_TYPE: "json",
        IS_NULLABLE: "NO",
        COLUMN_DEFAULT: null,
      },
      {
        COLUMN_NAME: "metadata",
        DATA_TYPE: "json",
        IS_NULLABLE: "NO",
        COLUMN_DEFAULT: null,
      },
    ]);

    const [checkpointBlobsColumns] = await sequelize.query(`
      SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'checkpoint_blobs'
      ORDER BY ORDINAL_POSITION
    `);

    expect(checkpointBlobsColumns).toEqual([
      {
        COLUMN_NAME: "thread_id",
        DATA_TYPE: "varchar",
        IS_NULLABLE: "NO",
        COLUMN_DEFAULT: null,
      },
      {
        COLUMN_NAME: "checkpoint_ns",
        DATA_TYPE: "varchar",
        IS_NULLABLE: "NO",
        COLUMN_DEFAULT: "",
      },
      {
        COLUMN_NAME: "channel",
        DATA_TYPE: "varchar",
        IS_NULLABLE: "NO",
        COLUMN_DEFAULT: null,
      },
      {
        COLUMN_NAME: "version",
        DATA_TYPE: "varchar",
        IS_NULLABLE: "NO",
        COLUMN_DEFAULT: null,
      },
      {
        COLUMN_NAME: "type",
        DATA_TYPE: "varchar",
        IS_NULLABLE: "NO",
        COLUMN_DEFAULT: null,
      },
      {
        COLUMN_NAME: "blob",
        DATA_TYPE: "longblob",
        IS_NULLABLE: "YES",
        COLUMN_DEFAULT: null,
      },
    ]);

    const [checkpointWritesColumns] = await sequelize.query(`
      SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'checkpoint_writes'
      ORDER BY ORDINAL_POSITION
    `);

    expect(checkpointWritesColumns).toEqual([
      {
        COLUMN_NAME: "thread_id",
        DATA_TYPE: "varchar",
        IS_NULLABLE: "NO",
        COLUMN_DEFAULT: null,
      },
      {
        COLUMN_NAME: "checkpoint_ns",
        DATA_TYPE: "varchar",
        IS_NULLABLE: "NO",
        COLUMN_DEFAULT: "",
      },
      {
        COLUMN_NAME: "checkpoint_id",
        DATA_TYPE: "varchar",
        IS_NULLABLE: "NO",
        COLUMN_DEFAULT: null,
      },
      {
        COLUMN_NAME: "task_id",
        DATA_TYPE: "varchar",
        IS_NULLABLE: "NO",
        COLUMN_DEFAULT: null,
      },
      {
        COLUMN_NAME: "idx",
        DATA_TYPE: "int",
        IS_NULLABLE: "NO",
        COLUMN_DEFAULT: null,
      },
      {
        COLUMN_NAME: "channel",
        DATA_TYPE: "varchar",
        IS_NULLABLE: "NO",
        COLUMN_DEFAULT: null,
      },
      {
        COLUMN_NAME: "type",
        DATA_TYPE: "varchar",
        IS_NULLABLE: "YES",
        COLUMN_DEFAULT: null,
      },
      {
        COLUMN_NAME: "blob",
        DATA_TYPE: "longblob",
        IS_NULLABLE: "NO",
        COLUMN_DEFAULT: null,
      },
    ]);

    // Verify migrations table has correct number of entries
    const [migrationsResult] = await sequelize.query(`
      SELECT COUNT(*) as count
      FROM checkpoint_migrations
    `);

    console.log("migrationsResult", migrationsResult);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(Number.parseInt((migrationsResult as any[])[0].count, 10)).toBe(0);
  });

  it("should save and retrieve checkpoints correctly", async () => {
    // get undefined checkpoint
    const undefinedCheckpoint = await mysqlSaver.getTuple({
      configurable: { thread_id: "1", checkpoint_ns: "" },
    });
    expect(undefinedCheckpoint).toBeUndefined();

    // save first checkpoint
    const runnableConfig = await mysqlSaver.put(
      { configurable: { thread_id: "1", checkpoint_ns: "" } },
      checkpoint1,
      { source: "update", step: -1, writes: null, parents: {} },
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
    await mysqlSaver.putWrites(
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
    const firstCheckpointTuple = await mysqlSaver.getTuple({
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
      writes: null,
      parents: {},
    });
    expect(firstCheckpointTuple?.parentConfig).toBeUndefined();
    expect(firstCheckpointTuple?.pendingWrites).toEqual([
      ["foo", "bar", "baz"],
    ]);

    // save second checkpoint
    await mysqlSaver.put(
      {
        configurable: {
          thread_id: "1",
          checkpoint_ns: "",
          checkpoint_id: "2024-04-18T17:19:07.952Z",
        },
      },
      checkpoint2,
      { source: "update", step: -1, writes: null, parents: {} },
      checkpoint2.channel_versions
    );

    // verify that parentTs is set and retrieved correctly for second checkpoint
    const secondCheckpointTuple = await mysqlSaver.getTuple({
      configurable: { thread_id: "1" },
    });
    expect(secondCheckpointTuple?.metadata).toEqual({
      source: "update",
      step: -1,
      writes: null,
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
    const checkpointTupleGenerator = mysqlSaver.list({
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
});

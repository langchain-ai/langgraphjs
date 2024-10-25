import {
  beforeAll,
  describe,
  it,
  expect,
  afterAll,
  beforeEach,
} from "@jest/globals";
import {
  MongoDBContainer,
  StartedMongoDBContainer,
} from "@testcontainers/mongodb";
import { Binary, MongoClient } from "mongodb";
import {
  Checkpoint,
  CheckpointMetadata,
  JsonPlusSerializer,
  uuid6,
} from "@langchain/langgraph-checkpoint";
import { Migration1ObjectMetadata } from "../../migrations/1_object_metadata.js";
import { isSkippedCIEnvironment } from "../utils.js";

describe("1_object_metadata", () => {
  if (!isSkippedCIEnvironment()) {
    const dbName = "test_db";
    let container: StartedMongoDBContainer;
    let client: MongoClient;

    beforeAll(async () => {
      container = await new MongoDBContainer("mongo:6.0.1").start();
      const connectionString = `mongodb://127.0.0.1:${container.getMappedPort(
        27017
      )}/${dbName}?directConnection=true`;
      client = new MongoClient(connectionString);
    });

    afterAll(async () => {
      await client.close();
      await container.stop();
    });

    describe("isApplicable", () => {
      // MongoDBSaver handles this automatically in initializeSchemaVersion
      it("should want to apply on empty database", async () => {
        // ensure database is empty
        const db = client.db(dbName);
        await db.dropDatabase();

        const migration = new Migration1ObjectMetadata({
          client,
          dbName,
          checkpointCollectionName: "checkpoints",
          checkpointWritesCollectionName: "checkpoint_writes",
          schemaVersionCollectionName: "schema_version",
          serializer: new JsonPlusSerializer(),
          currentSchemaVersion: 1,
        });
        expect(await migration.isApplicable()).toBe(true);
      });

      it("should not want to apply on database with schema version of 1", async () => {
        const db = client.db(dbName);
        await db.dropDatabase();
        await db.createCollection("schema_version");
        await db.collection("schema_version").insertOne({ version: 1 });

        const migration = new Migration1ObjectMetadata({
          client,
          dbName,
          checkpointCollectionName: "checkpoints",
          checkpointWritesCollectionName: "checkpoint_writes",
          schemaVersionCollectionName: "schema_version",
          serializer: new JsonPlusSerializer(),
          currentSchemaVersion: 1,
        });
        expect(await migration.isApplicable()).toBe(false);
      });
    });

    describe("apply", () => {
      const expectedCheckpoints: Record<
        string,
        {
          parent_checkpoint_id?: string;
          checkpoint: Binary;
          type: string;
          metadata: CheckpointMetadata;
          thread_id: string;
          checkpoint_ns: string;
          checkpoint_id: string;
        }
      > = {};

      beforeEach(async () => {
        const serde = new JsonPlusSerializer();
        const dropDb = client.db(dbName);
        await dropDb.dropDatabase();
        const db = client.db(dbName);
        await db.createCollection("checkpoints");
        await db.createCollection("schema_version");

        for (let i = 0; i < 10; i += 1) {
          const checkpoint_id = uuid6(-3);
          const thread_id = uuid6(-3);
          const checkpoint_ns = "";

          const checkpoint: Checkpoint = {
            v: 1,
            id: checkpoint_id,
            ts: new Date().toISOString(),
            channel_values: {},
            channel_versions: {},
            versions_seen: {},
            pending_sends: [],
          };

          const metadata: CheckpointMetadata = {
            source: "update",
            step: -1,
            writes: {},
            parents: {},
          };

          const [checkpointType, serializedCheckpoint] =
            serde.dumpsTyped(checkpoint);
          const serializedMetadata = serde.dumpsTyped(metadata)[1];

          await db.collection("checkpoints").insertOne({
            type: checkpointType,
            checkpoint: serializedCheckpoint,
            metadata: serializedMetadata,
            thread_id,
            checkpoint_ns,
            checkpoint_id,
          });

          expectedCheckpoints[checkpoint_id] = {
            checkpoint: new Binary(serializedCheckpoint),
            type: checkpointType,
            metadata,
            thread_id,
            checkpoint_ns,
            checkpoint_id,
          };
        }
      });

      it("should migrate all checkpoints", async () => {
        const migration = new Migration1ObjectMetadata({
          client,
          dbName,
          checkpointCollectionName: "checkpoints",
          checkpointWritesCollectionName: "checkpoint_writes",
          schemaVersionCollectionName: "schema_version",
          serializer: new JsonPlusSerializer(),
          currentSchemaVersion: 1,
        });
        await migration.apply();

        const db = client.db(dbName);
        const cursor = await db.collection("checkpoints").find({});

        let docCount = 0;
        for await (const actual of cursor) {
          docCount += 1;
          const expected = expectedCheckpoints[actual.checkpoint_id];
          expect(actual.parent_checkpoint_id).toBe(
            expected.parent_checkpoint_id
          );
          expect(actual.type).toBe(expected.type);
          expect(actual.checkpoint).toEqual(expected.checkpoint);
          expect(actual.metadata).toEqual(expected.metadata);
          expect(actual.thread_id).toBe(expected.thread_id);
          expect(actual.checkpoint_ns).toBe(expected.checkpoint_ns);
          expect(actual.checkpoint_id).toBe(expected.checkpoint_id);
        }
        expect(docCount).toBe(10);
      });
    });
  } else {
    it.skip("GitHub can't run containers on M-Series macOS runners due to lack of support for nested virtualization.", () => {});
  }
});

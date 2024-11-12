import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { Checkpoint, CheckpointTuple, uuid6 } from "@langchain/langgraph-checkpoint";
import { FirebaseSaver } from "../index.js";
import { initializeApp } from "firebase/app";
import { getDatabase, ref, remove, Database } from "firebase/database";
import { GenericContainer, StartedTestContainer } from "testcontainers";

const FIREBASE_PORT = 9000;

// Example: Replace this URL with your database URL
const databaseURL = "https://your-database-name.firebaseio.com";

// Initialize Firebase App with only the databaseURL
const app = initializeApp({
  databaseURL: databaseURL,
});

// Get the database instance
const database = getDatabase(app);

console.log("Database initialized with URL:", databaseURL);

// class FirebaseTestContainer {
//   container?: StartedTestContainer;

//   async start() {
//     this.container = await new GenericContainer("firebase/firebase-tools")
//       .withExposedPorts(FIREBASE_PORT)
//       .withCmd([
//         "emulators:start",
//         "--only",
//         "database",
//         "--project",
//         "test-project",
//       ])
//       .start();

//     return this.getDatabaseUrl();
//   }

//   async stop() {
//     if (this.container) {
//       await this.container.stop();
//     }
//   }

//   getDatabaseUrl() {
//     if (!this.container) {
//       throw new Error("Firebase container has not been started.");
//     }

//     const port = this.container.getMappedPort(FIREBASE_PORT);
//     return `http://localhost:${port}`;
//   }
// }

// const testContainer = new FirebaseTestContainer();

// export const initializer: any = {
//   checkpointerName: "@langchain/langgraph-checkpoint-firebase",

//   async beforeAll() {
//     const databaseUrl = await testContainer.start();

//     // Initialize Firebase Client SDK pointing to the emulator
//     initializeApp({
//       databaseURL: databaseUrl,
//     });

//     console.log(`Firebase Emulator running at ${databaseUrl}`);
//   },

//   beforeAllTimeout: 300_000, // five minutes to set up Firebase emulator

//   async createCheckpointer() {
//     const database = getDatabase();
//     return new FirebaseSaver(database);
//   },

//   async afterAll() {
//     await testContainer.stop();
//   },
// };

// Define test checkpoints
const checkpoint1: Checkpoint = {
  v: 1,
  id: uuid6(-1),
  ts: "2024-04-19T17:19:07.952Z",
  channel_values: { someKey1: "someValue1" },
  channel_versions: { someKey2: 1 },
  versions_seen: { someKey3: { someKey4: 1 } },
  pending_sends: [],
};

const checkpoint2: Checkpoint = {
  v: 1,
  id: uuid6(1),
  ts: "2024-04-20T17:19:07.952Z",
  channel_values: { someKey1: "someValue2" },
  channel_versions: { someKey2: 2 },
  versions_seen: { someKey3: { someKey4: 2 } },
  pending_sends: [],
};

// Helper to clean up database paths
async function clearCollection(database: Database, path: string): Promise<void> {
  const collectionRef = ref(database, path);
  await remove(collectionRef);
}

let saver: FirebaseSaver;
let database: Database;

beforeAll(async () => {
  await initializer.beforeAll();
  saver = await initializer.createCheckpointer();
  database = getDatabase(); // Access database for cleanup
}, initializer.beforeAllTimeout);

afterAll(async () => {
  await clearCollection(database, "checkpoints");
  await clearCollection(database, "checkpoint-writes");
  await initializer.afterAll();
});

describe("FirebaseSaver", () => {
  it("should save and retrieve checkpoints correctly", async () => {
    // Get undefined checkpoint
    const undefinedCheckpoint = await saver.getTuple({
      configurable: { thread_id: "1" },
    });
    expect(undefinedCheckpoint).toBeUndefined();

    // Save first checkpoint
    const runnableConfig = await saver.put(
      { configurable: { thread_id: "1" } },
      checkpoint1,
      { source: "update", step: -1, writes: null, parents: {} }
    );
    expect(runnableConfig).toEqual({
      configurable: {
        thread_id: "1",
        checkpoint_ns: "",
        checkpoint_id: checkpoint1.id,
      },
    });

    // Add some writes
    await saver.putWrites(
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

    // Get first checkpoint tuple
    const firstCheckpointTuple = await saver.getTuple({
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
    expect(firstCheckpointTuple?.parentConfig).toBeUndefined();
    expect(firstCheckpointTuple?.pendingWrites).toEqual([
      ["foo", "bar", "baz"],
    ]);

    // Save second checkpoint
    await saver.put(
      {
        configurable: {
          thread_id: "1",
          checkpoint_id: "2024-04-18T17:19:07.952Z",
        },
      },
      checkpoint2,
      { source: "update", step: -1, writes: null, parents: {} }
    );

    // Verify that parentTs is set and retrieved correctly for second checkpoint
    const secondCheckpointTuple = await saver.getTuple({
      configurable: { thread_id: "1" },
    });
    expect(secondCheckpointTuple?.parentConfig).toEqual({
      configurable: {
        thread_id: "1",
        checkpoint_ns: "",
        checkpoint_id: "2024-04-18T17:19:07.952Z",
      },
    });

    // List checkpoints
    const checkpointTupleGenerator = saver.list({
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

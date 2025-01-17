import { SqlStorage, SqlStorageCursor, SqlStorageStatement } from "@cloudflare/workers-types";
import { describe, expect, it, jest } from "@jest/globals";
import {
  Checkpoint,
  CheckpointTuple,
  uuid6,
} from "@langchain/langgraph-checkpoint";
import { CloudflareDurableObjectSqliteSaver } from "../index.js";

const checkpoint1: Checkpoint = {
  v: 1,
  id: uuid6(-1),
  ts: "2024-04-19T17:19:07.952Z",
  channel_values: {
    someKey1: "someValue1",
  },
  channel_versions: {
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
    someKey2: 2,
  },
  versions_seen: {
    someKey3: {
      someKey4: 2,
    },
  },
  pending_sends: [],
};

describe("CloudflareDurableObjectSqliteSaver", () => {
  it("should save and retrieve checkpoints correctly", async () => {
    const mockResults = new Map();
    const db = {
      exec: jest.fn((sql: string, ...params: any[]) => {
        if (sql.includes('CREATE TABLE')) {
          return [];
        }

        if (sql.includes('SELECT')) {
          if (!mockResults.has('checkpoint')) {
            return [];
          }
          
          return [{
            thread_id: "1",
            checkpoint_ns: "",
            checkpoint_id: mockResults.get('checkpoint').id,
            type: "json",
            checkpoint: JSON.stringify(mockResults.get('checkpoint')),
            metadata: JSON.stringify(mockResults.get('metadata')),
            pending_writes: JSON.stringify(mockResults.get('writes') || []),
            parent_checkpoint_id: mockResults.get('parent_id')
          }];
        }

        // Handle INSERT statements
        if (sql.includes('INSERT')) {
          if (sql.includes('checkpoints')) {
            mockResults.set('checkpoint', JSON.parse(params[5]));
            mockResults.set('metadata', JSON.parse(params[6]));
            mockResults.set('parent_id', params[3]);
          } else if (sql.includes('writes')) {
            const writes = mockResults.get('writes') || [];
            writes.push({
              task_id: params[3],
              channel: params[5],
              type: "json",
              value: JSON.stringify(params[7])
            });
            mockResults.set('writes', writes);
          }
          return [];
        }

        return [];
      }),
      databaseSize: 0,
      Cursor: SqlStorageCursor,
      Statement: SqlStorageStatement
    } as unknown as SqlStorage;

    const sqliteSaver = new CloudflareDurableObjectSqliteSaver(db);

    // get undefined checkpoint
    const undefinedCheckpoint = await sqliteSaver.getTuple({
      configurable: { thread_id: "1" },
    });
    expect(undefinedCheckpoint).toBeUndefined();

    // save first checkpoint
    const runnableConfig = await sqliteSaver.put(
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

    // add some writes
    await sqliteSaver.putWrites(
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
    const firstCheckpointTuple = await sqliteSaver.getTuple({
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

    // save second checkpoint
    await sqliteSaver.put(
      {
        configurable: {
          thread_id: "1",
          checkpoint_id: "2024-04-18T17:19:07.952Z",
        },
      },
      checkpoint2,
      {
        source: "update",
        step: -1,
        writes: null,
        parents: { "": checkpoint1.id },
      }
    );

    // verify that parentTs is set and retrieved correctly for second checkpoint
    const secondCheckpointTuple = await sqliteSaver.getTuple({
      configurable: { thread_id: "1" },
    });
    expect(secondCheckpointTuple?.parentConfig).toEqual({
      configurable: {
        thread_id: "1",
        checkpoint_ns: "",
        checkpoint_id: "2024-04-18T17:19:07.952Z",
      },
    });

    // list checkpoints
    const checkpointTupleGenerator = sqliteSaver.list(
      {
        configurable: { thread_id: "1" },
      },
      {
        filter: {
          source: "update",
          step: -1,
          parents: { "": checkpoint1.id },
        },
      }
    );
    const checkpointTuples: CheckpointTuple[] = [];
    for await (const checkpoint of checkpointTupleGenerator) {
      checkpointTuples.push(checkpoint);
    }
    expect(checkpointTuples.length).toBe(1);

    const checkpointTuple1 = checkpointTuples[0];
    expect(checkpointTuple1.checkpoint.ts).toBe("2024-04-20T17:19:07.952Z");
  });
});

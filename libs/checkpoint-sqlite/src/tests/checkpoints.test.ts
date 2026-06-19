import { describe, it, expect } from "vitest";
import {
  Checkpoint,
  CheckpointTuple,
  emptyCheckpoint,
  INTERRUPT,
  RESUME,
  TASKS,
  uuid6,
} from "@langchain/langgraph-checkpoint";
import type { RunnableConfig } from "@langchain/core/runnables";
import { SqliteSaver } from "../index.js";

const checkpoint1: Checkpoint = {
  v: 1,
  id: uuid6(0),
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
};

describe("SqliteSaver", () => {
  it("should save and retrieve checkpoints correctly", async () => {
    const sqliteSaver = SqliteSaver.fromConnString(":memory:");

    // get undefined checkpoint
    const undefinedCheckpoint = await sqliteSaver.getTuple({
      configurable: { thread_id: "1" },
    });
    expect(undefinedCheckpoint).toBeUndefined();

    // save first checkpoint
    const runnableConfig = await sqliteSaver.put(
      { configurable: { thread_id: "1" } },
      checkpoint1,
      { source: "update", step: -1, parents: {} }
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
    const checkpointTupleGenerator = await sqliteSaver.list(
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

  it("should preserve INTERRUPT/RESUME writes at fixed negative indices and not clobber prior regular writes", async () => {
    const sqliteSaver = SqliteSaver.fromConnString(":memory:");
    // Persist a checkpoint first so that getTuple can resolve and dump back
    // the writes we attached to it via putWrites.
    const checkpoint: Checkpoint = {
      ...emptyCheckpoint(),
      id: uuid6(1),
      ts: "2024-04-19T17:19:07.952Z",
    };
    const savedConfig = await sqliteSaver.put(
      { configurable: { thread_id: "t1" } },
      checkpoint,
      {
        source: "input",
        step: -1,
        parents: {},
      } as Parameters<typeof sqliteSaver.put>[2]
    );
    const config: RunnableConfig = {
      configurable: {
        thread_id: "t1",
        checkpoint_ns: savedConfig.configurable!.checkpoint_ns,
        checkpoint_id: checkpoint.id,
      },
    };

    // 1. Task A stores two regular writes (idx 0 and 1).
    await sqliteSaver.putWrites(
      config,
      [
        ["foo", "val_foo"],
        ["bar", "val_bar"],
      ],
      "task_A"
    );

    // 2. Task A then signals an INTERRUPT for the same checkpoint.
    //    Previously this would have been stored at idx=0 (it's the first write
    //    in the new putWrites call) and silently REPLACEd the row above, since
    //    the table is keyed by (thread_id, checkpoint_ns, checkpoint_id,
    //    task_id, idx). With WRITES_IDX_MAP it lands at idx=-3 instead.
    await sqliteSaver.putWrites(config, [[INTERRUPT, "paused"]], "task_A");

    // 3. Task A is later resumed; RESUME also has a fixed idx (-4) and is
    //    allowed to overwrite the prior RESUME for the same task — but it
    //    must not collide with anything else.
    await sqliteSaver.putWrites(config, [[RESUME, "carry_on"]], "task_A");

    // 4. A concurrent Task B stores a regular write of its own. Its idx=0
    //    must not overwrite Task A's INTERRUPT/RESUME, and conversely it
    //    must not be ignored just because some other task happened to use
    //    idx=0.
    await sqliteSaver.putWrites(config, [["baz", "val_baz"]], "task_B");

    // Round-trip through getTuple so we exercise the same row layout consumers
    // see; pendingWrites is [taskId, channel, value][] in put order.
    const tuple = await sqliteSaver.getTuple(config);
    const writes = tuple?.pendingWrites?.map(
      ([taskId, channel]) => `${taskId}:${channel}`
    );

    // All four logical writes from Task A plus Task B's write must survive.
    expect(new Set(writes)).toEqual(
      new Set([
        "task_A:foo",
        "task_A:bar",
        "task_A:__interrupt__",
        "task_A:__resume__",
        "task_B:baz",
      ])
    );
  });

  it("should filter on arbitrary metadata keys, not just CheckpointMetadata keys", async () => {
    const sqliteSaver = SqliteSaver.fromConnString(":memory:");

    const put = (id: string, tenant: string, env: string) =>
      sqliteSaver.put(
        { configurable: { thread_id: id } },
        {
          ...emptyCheckpoint(),
          id: uuid6(parseInt(id, 10)),
          ts: `2024-06-08T0${id}:00:00.000Z`,
        },
        {
          source: "update",
          step: 0,
          parents: {},
          // arbitrary user-defined keys that other checkpointers
          // (MongoDB / Postgres / Redis) all support
          tenant_id: tenant,
          env,
        } as Parameters<typeof sqliteSaver.put>[2]
      );

    await put("1", "acme", "prod");
    await put("2", "acme", "dev");
    await put("3", "globex", "prod");

    const collect = async (
      filter: Record<string, unknown>
    ): Promise<CheckpointTuple[]> => {
      const tuples: CheckpointTuple[] = [];
      for await (const t of sqliteSaver.list({} as RunnableConfig, { filter })) {
        tuples.push(t);
      }
      return tuples;
    };

    const ids = (tuples) => tuples.map(t => t.config.configurable?.thread_id).sort();
    expect(ids(await collect({ tenant_id: "acme" }))).toEqual(["1", "2"]);
    expect((await collect({ env: "prod" })).length).toBe(2);
    expect((await collect({ tenant_id: "acme", env: "prod" })).length).toBe(1);
    expect((await collect({ tenant_id: "missing" })).length).toBe(0);
  });

  it("should delete thread", async () => {
    const saver = SqliteSaver.fromConnString(":memory:");
    await saver.put({ configurable: { thread_id: "1" } }, emptyCheckpoint(), {
      source: "update",
      step: -1,
      parents: {},
    });

    await saver.put({ configurable: { thread_id: "2" } }, emptyCheckpoint(), {
      source: "update",
      step: -1,
      parents: {},
    });

    await saver.deleteThread("1");

    expect(
      await saver.getTuple({ configurable: { thread_id: "1" } })
    ).toBeUndefined();

    expect(
      await saver.getTuple({ configurable: { thread_id: "2" } })
    ).toBeDefined();
  });

  it("pending sends migration", async () => {
    const saver = SqliteSaver.fromConnString(":memory:");

    let config: RunnableConfig = {
      configurable: { thread_id: "thread-1", checkpoint_ns: "" },
    };

    const checkpoint0 = emptyCheckpoint();

    config = await saver.put(config, checkpoint0, {
      source: "loop",
      parents: {},
      step: 0,
    });

    await saver.putWrites(
      config,
      [
        [TASKS, "send-1"],
        [TASKS, "send-2"],
      ],
      "task-1"
    );
    await saver.putWrites(config, [[TASKS, "send-3"]], "task-2");

    // check that fetching checkpount 0 doesn't attach pending sends
    // (they should be attached to the next checkpoint)
    const tuple0 = await saver.getTuple(config);
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
    };
    config = await saver.put(config, checkpoint1, {
      source: "loop",
      parents: {},
      step: 1,
    });

    // check that pending sends are attached to checkpoint1
    const checkpoint1Tuple = await saver.getTuple(config);
    expect(checkpoint1Tuple?.checkpoint.channel_values).toEqual({
      [TASKS]: ["send-1", "send-2", "send-3"],
    });
    expect(checkpoint1Tuple?.checkpoint.channel_versions[TASKS]).toBeDefined();

    // check that the list also applies the migration
    const checkpointTupleGenerator = saver.list({
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

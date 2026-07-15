import { describe, expect, it } from "vitest";
import {
  type Checkpoint,
  emptyCheckpoint,
  MemorySaver,
  type CheckpointPendingWrite,
} from "@langchain/langgraph-checkpoint";
import { Annotation } from "../graph/annotation.js";
import { Graph } from "../graph/graph.js";
import { StateGraph } from "../graph/state.js";
import { END, START } from "../constants.js";
import {
  migrateCheckpoint,
  validateStateMigrations,
  type StateMigrationState,
} from "../pregel/migrations.js";

const State = Annotation.Root({
  value: Annotation<string>(),
});

function makeGraph(
  checkpointer: MemorySaver,
  options: Parameters<typeof StateGraph.prototype.compile>[0]
) {
  return new StateGraph(State)
    .addNode("set_value", () => ({ value: "old" }))
    .addNode("finish", (state) => ({ value: `${state.value}!` }))
    .addEdge(START, "set_value")
    .addEdge("set_value", "finish")
    .compile({ checkpointer, interruptBefore: ["finish"], ...options });
}

describe("graph state migrations", () => {
  it("migrates a checkpoint before resuming and records the new version", async () => {
    const checkpointer = new MemorySaver();
    const config = { configurable: { thread_id: "migration-thread" } };
    const oldGraph = makeGraph(checkpointer, { graphVersion: 1 });

    await oldGraph.invoke({ value: "initial" }, config);
    const oldCheckpoint = await checkpointer.getTuple(config);
    expect(oldCheckpoint?.metadata?.graph_version).toBe(1);

    const newGraph = makeGraph(checkpointer, {
      graphVersion: 3,
      stateMigrations: [
        {
          from: 1,
          to: 2,
          migrate: (state) => {
            state.checkpoint.channel_values.value = "migrated";
            return state;
          },
        },
        {
          from: 2,
          to: 3,
          migrate: (state) => {
            state.checkpoint.channel_values.value = `${String(state.checkpoint.channel_values.value)}-v3`;
            return state;
          },
        },
      ],
    });

    const snapshot = await newGraph.getState(config);
    expect(snapshot.values).toEqual({ value: "migrated-v3" });

    const result = await newGraph.invoke(null, config);
    expect(result).toEqual({ value: "migrated-v3!" });

    const newCheckpoint = await checkpointer.getTuple(config);
    expect(newCheckpoint?.metadata?.graph_version).toBe(3);
  });

  it("can migrate checkpoints created before version metadata existed", async () => {
    const checkpointer = new MemorySaver();
    const config = { configurable: { thread_id: "legacy-thread" } };
    const oldGraph = makeGraph(checkpointer, {});
    await oldGraph.invoke({ value: "initial" }, config);

    const newGraph = makeGraph(checkpointer, {
      graphVersion: 2,
      legacyGraphVersion: 1,
      stateMigrations: [
        {
          from: 1,
          to: 2,
          migrate: (state) => {
            state.checkpoint.channel_values.value = "legacy-migrated";
            return state;
          },
        },
      ],
    });

    await expect(newGraph.invoke(null, config)).resolves.toEqual({
      value: "legacy-migrated!",
    });
  });

  it("migrates before manual state updates", async () => {
    const checkpointer = new MemorySaver();
    const config = { configurable: { thread_id: "update-thread" } };
    const oldGraph = makeGraph(checkpointer, { graphVersion: 1 });
    await oldGraph.invoke({ value: "initial" }, config);

    const newGraph = makeGraph(checkpointer, {
      graphVersion: 2,
      stateMigrations: [
        {
          from: 1,
          to: 2,
          migrate: (state) => {
            state.checkpoint.channel_values.value = "migrated";
            return state;
          },
        },
      ],
    });

    await newGraph.updateState(config, { value: "manual" }, "finish");
    const snapshot = await newGraph.getState(config);
    expect(snapshot.values).toEqual({ value: "manual" });
    expect(snapshot.metadata?.graph_version).toBe(2);
  });

  it("fails closed when a checkpoint version has no migration", async () => {
    const checkpointer = new MemorySaver();
    const config = { configurable: { thread_id: "missing-migration" } };
    const oldGraph = makeGraph(checkpointer, { graphVersion: "old" });
    await oldGraph.invoke({ value: "initial" }, config);

    const newGraph = makeGraph(checkpointer, { graphVersion: "new" });
    await expect(newGraph.invoke(null, config)).rejects.toThrow(
      "No state migration is registered from graph version old to new"
    );
  });

  it("requires an explicit legacy version for unversioned persisted checkpoints", async () => {
    const checkpointer = new MemorySaver();
    const config = { configurable: { thread_id: "unversioned-checkpoint" } };
    await makeGraph(checkpointer, {}).invoke({ value: "initial" }, config);

    const graph = makeGraph(checkpointer, { graphVersion: 2 });
    await expect(graph.getState(config)).rejects.toThrow(
      "has no graph_version"
    );
  });

  it("migrates pending writes and isolates nested values from the input tuple", async () => {
    const checkpoint = emptyCheckpoint();
    checkpoint.channel_values.profile = { name: "old" };
    checkpoint.channel_values.items = Object.assign(new Array(3), {
      0: "old",
    });
    const pendingWrites: CheckpointPendingWrite[] = [
      ["task", "resume", { name: "old" }],
    ];

    const migrated = await migrateCheckpoint({
      checkpoint,
      pendingWrites,
      metadata: { source: "loop", step: 0, parents: {}, graph_version: 1 },
      graphVersion: 2,
      migrations: [
        {
          from: 1,
          to: 2,
          migrate: (state) => {
            (state.checkpoint.channel_values.profile as { name: string }).name =
              "new";
            (state.checkpoint.channel_values.items as string[])[1] = "new";
            (state.pendingWrites[0][2] as { name: string }).name = "new";
            return state;
          },
        },
      ],
    });

    expect(checkpoint.channel_values.profile).toEqual({ name: "old" });
    expect(checkpoint.channel_values.items).toHaveLength(3);
    expect(checkpoint.channel_values.items).not.toHaveProperty("1");
    expect(pendingWrites[0][2]).toEqual({ name: "old" });
    expect(migrated.checkpoint.channel_values.profile).toEqual({ name: "new" });
    expect(migrated.checkpoint.channel_values.items).toHaveLength(3);
    expect(migrated.checkpoint.channel_values.items).toMatchObject({
      0: "old",
      1: "new",
    });
    expect(migrated.checkpoint.channel_values.items).not.toHaveProperty("2");
    expect(migrated.pendingWrites[0][2]).toEqual({ name: "new" });
  });

  it("protects checkpoint identity across every migration hop", async () => {
    const checkpoint = emptyCheckpoint();
    await expect(
      migrateCheckpoint({
        checkpoint,
        metadata: { source: "loop", step: 0, parents: {}, graph_version: 1 },
        graphVersion: 2,
        migrations: [
          {
            from: 1,
            to: 2,
            migrate: (state) => {
              state.checkpoint.id = "different-id";
              return state;
            },
          },
        ],
      })
    ).rejects.toThrow("cannot change checkpoint id");
  });

  it("rejects migrations that could replay DeltaChannel ancestor history", async () => {
    await expect(
      migrateCheckpoint({
        checkpoint: emptyCheckpoint(),
        metadata: { source: "loop", step: 0, parents: {}, graph_version: 1 },
        graphVersion: 2,
        hasDeltaChannels: true,
        migrations: [
          {
            from: 1,
            to: 2,
            migrate: (state) => state,
          },
        ],
      })
    ).rejects.toThrow("not supported for graphs with DeltaChannel");
  });

  it("requires migrations to return a complete migration state", async () => {
    const invalidMigration = (() => ({
      checkpoint: emptyCheckpoint(),
    })) as unknown as StateMigrationState;

    await expect(
      migrateCheckpoint({
        checkpoint: emptyCheckpoint(),
        metadata: { source: "loop", step: 0, parents: {}, graph_version: 1 },
        graphVersion: 2,
        migrations: [
          {
            from: 1,
            to: 2,
            migrate: () => invalidMigration,
          },
        ],
      })
    ).rejects.toThrow("valid checkpoint and pendingWrites array");
  });

  it("validates raw persisted checkpoint shapes before normalization", async () => {
    const malformedCheckpoint = {
      ...emptyCheckpoint(),
      channel_values: null,
    } as unknown as Checkpoint;

    await expect(
      migrateCheckpoint({
        checkpoint: malformedCheckpoint,
        graphVersion: 1,
        isNewCheckpoint: true,
      })
    ).rejects.toThrow("not valid persisted state");

    await expect(
      migrateCheckpoint({
        checkpoint: emptyCheckpoint(),
        pendingWrites: null as unknown as CheckpointPendingWrite[],
        graphVersion: 1,
        isNewCheckpoint: true,
      })
    ).rejects.toThrow("invalid pending writes");
  });

  it("validates graph versions at runtime", () => {
    expect(() =>
      validateStateMigrations(NaN as unknown as number, undefined, undefined)
    ).toThrow("graphVersion must be a finite number or string");

    expect(() =>
      validateStateMigrations(
        2,
        undefined,
        [
          {
            from: 1,
            to: NaN as unknown as number,
            migrate: (state) => state,
          },
        ]
      )
    ).toThrow("stateMigrations.to must be a finite number or string");
  });

  it("forwards versioning options through generic Graph.compile", () => {
    const graph = new Graph()
      .addNode("node", () => ({}))
      .addEdge(START, "node")
      .addEdge("node", END)
      .compile({ graphVersion: 1 });

    expect(graph.graphVersion).toBe(1);
  });
});

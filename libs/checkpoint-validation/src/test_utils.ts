import {
  BaseCheckpointSaver,
  ChannelVersions,
  CheckpointPendingWrite,
  PendingWrite,
  TASKS,
  uuid6,
  type CheckpointTuple,
} from "@langchain/langgraph-checkpoint";

// to make the type signature of the skipOnModules function a bit more readable
export type CheckpointerName = string;
export type WhySkipped = string;

/**
 * Conditionally skips a test for a specific checkpointer implementation. When the test is skipped, the reason for
 * skipping is provided.
 *
 * @param checkpointerName - The name of the current module being tested (as passed via the `name` argument in the top-level suite entrypoint).
 * @param skippedCheckpointers - A list of modules for which the test should be skipped.
 * @returns A function that can be used in place of the Vitest @see it function and conditionally skips the test for the provided module.
 */
export function it_skipForSomeModules(
  checkpointerName: string,
  skippedCheckpointers: Record<CheckpointerName, WhySkipped>
): typeof it | typeof it.skip {
  const skipReason = skippedCheckpointers[checkpointerName];

  if (skipReason) {
    const skip = (...args: Parameters<typeof it.skip>) => {
      const [name, test, timeout] = args;
      it.skip(`[because ${skipReason}] ${name}`, test, timeout);
    };
    skip.prototype = it.skip.prototype;
    return skip as typeof it.skip;
  }

  return it;
}

export interface InitialCheckpointTupleConfig {
  thread_id: string;
  checkpoint_id: string;
  checkpoint_ns: string;
  channel_values?: Record<string, unknown>;
  channel_versions?: ChannelVersions;
}
export function initialCheckpointTuple({
  thread_id,
  checkpoint_id,
  checkpoint_ns,
  channel_values = {},
}: InitialCheckpointTupleConfig): CheckpointTuple {
  if (checkpoint_ns === undefined) {
    throw new Error("checkpoint_ns is required");
  }

  const channel_versions = Object.fromEntries(
    Object.keys(channel_values).map((key) => [key, 1])
  );

  const config = {
    configurable: {
      thread_id,
      checkpoint_id,
      checkpoint_ns,
    },
  };

  return {
    config,
    checkpoint: {
      v: 4,
      ts: new Date().toISOString(),
      id: checkpoint_id,
      channel_values,
      channel_versions,
      versions_seen: {
        // this is meant to be opaque to checkpointers, so we just stuff dummy data in here to make sure it's stored and retrieved
        "": { someChannel: 1 },
      },
    },

    metadata: {
      source: "input",
      step: -1,
      parents: {},
    },
  };
}

export interface ParentAndChildCheckpointTuplesWithWritesConfig {
  thread_id: string;
  parentCheckpointId: string;
  childCheckpointId: string;
  checkpoint_ns: string;
  initialChannelValues?: Record<string, unknown>;
  writesToParent?: { taskId: string; writes: PendingWrite[] }[];
  writesToChild?: { taskId: string; writes: PendingWrite[] }[];
}

export function parentAndChildCheckpointTuplesWithWrites({
  thread_id,
  parentCheckpointId,
  childCheckpointId,
  checkpoint_ns,
  initialChannelValues = {},
  writesToParent = [],
  writesToChild = [],
}: ParentAndChildCheckpointTuplesWithWritesConfig): {
  parent: CheckpointTuple;
  child: CheckpointTuple;
} {
  if (checkpoint_ns === undefined) {
    throw new Error("checkpoint_ns is required");
  }

  const parentChannelVersions = Object.fromEntries(
    Object.keys(initialChannelValues).map((key) => [key, 1])
  );

  const parentPendingWrites = writesToParent.flatMap(({ taskId, writes }) =>
    writes.map(
      ([channel, value]) => [taskId, channel, value] as CheckpointPendingWrite
    )
  );

  const composedChildWritesByChannel = writesToChild.reduce(
    (acc, { writes }) => {
      writes.forEach(([channel, value]) => {
        acc[channel] = [channel, value];
      });
      return acc;
    },
    {} as Record<string, PendingWrite>
  );

  const childWriteCountByChannel = writesToChild.reduce((acc, { writes }) => {
    writes.forEach(([channel, _]) => {
      acc[channel] = (acc[channel] || 0) + 1;
    });
    return acc;
  }, {} as Record<string, number>);

  const childChannelVersions = Object.fromEntries(
    Object.entries(parentChannelVersions).map(([key, value]) => [
      key,
      key in childWriteCountByChannel
        ? value + childWriteCountByChannel[key]
        : value,
    ])
  );

  const childPendingWrites = writesToChild.flatMap(({ taskId, writes }) =>
    writes.map(
      ([channel, value]) => [taskId, channel, value] as CheckpointPendingWrite
    )
  );

  const childChannelValues = {
    ...initialChannelValues,
    ...composedChildWritesByChannel,
  };

  return {
    parent: {
      checkpoint: {
        v: 4,
        ts: new Date().toISOString(),
        id: parentCheckpointId,
        channel_values: initialChannelValues,
        channel_versions: parentChannelVersions,
        versions_seen: {
          // this is meant to be opaque to checkpointers, so we just stuff dummy data in here to make sure it's stored and retrieved
          "": {
            someChannel: 1,
          },
        },
      },
      metadata: {
        source: "input",
        step: -1,
        parents: {},
      },
      config: {
        configurable: {
          thread_id,
          checkpoint_ns,
          checkpoint_id: parentCheckpointId,
        },
      },
      parentConfig: undefined,
      pendingWrites: parentPendingWrites,
    },
    child: {
      checkpoint: {
        v: 4,
        ts: new Date().toISOString(),
        id: childCheckpointId,
        channel_values: childChannelValues,
        channel_versions: childChannelVersions,
        versions_seen: {
          // this is meant to be opaque to checkpointers, so we just stuff dummy data in here to make sure it's stored and retrieved
          "": {
            someChannel: 1,
          },
        },
        // pending_sends,
      },
      metadata: {
        source: "loop",
        step: 0,
        parents: {
          [checkpoint_ns]: parentCheckpointId,
        },
      },
      config: {
        configurable: {
          thread_id,
          checkpoint_ns,
          checkpoint_id: childCheckpointId,
        },
      },
      parentConfig: {
        configurable: {
          thread_id,
          checkpoint_ns,
          checkpoint_id: parentCheckpointId,
        },
      },
      pendingWrites: childPendingWrites,
    },
  };
}

export function* generateTuplePairs(
  countPerNamespace: number,
  namespaces: string[]
): Generator<{
  tuple: CheckpointTuple;
  writes: { writes: PendingWrite[]; taskId: string }[];
  newVersions: Record<string, number | string>;
}> {
  for (let i = 0; i < countPerNamespace; i += 1) {
    const thread_id = uuid6(-3);
    for (const checkpoint_ns of namespaces) {
      const parentCheckpointId = uuid6(-3);
      const childCheckpointId = uuid6(-3);

      const writesToParent = [
        {
          writes: [[TASKS, ["add_fish"]]] as PendingWrite[],
          taskId: "pending_sends_task",
        },
      ];
      const writesToChild = [
        {
          writes: [["animals", ["fish", "dog"]]] as PendingWrite[],
          taskId: "add_fish",
        },
      ];
      const initialChannelValues = {
        animals: ["dog"],
      };

      const { parent, child } = parentAndChildCheckpointTuplesWithWrites({
        thread_id,
        checkpoint_ns,
        parentCheckpointId,
        childCheckpointId,
        initialChannelValues,
        writesToParent,
        writesToChild,
      });

      yield {
        tuple: parent,
        writes: writesToParent,
        newVersions: parent.checkpoint.channel_versions,
      };
      yield {
        tuple: child,
        writes: writesToChild,
        newVersions: Object.fromEntries(
          Object.entries(child.checkpoint.channel_versions).filter(
            ([key, ver]) => parent.checkpoint.channel_versions[key] !== ver
          )
        ) as Record<string, number | string>,
      };
    }
  }
}

export async function* putTuples(
  checkpointer: BaseCheckpointSaver,
  generatedTuples: {
    tuple: CheckpointTuple;
    writes: { writes: PendingWrite[]; taskId: string }[];
    newVersions: Record<string, number | string>;
  }[]
): AsyncGenerator<CheckpointTuple> {
  for (const generated of generatedTuples) {
    const { thread_id, checkpoint_ns } = generated.tuple.config
      .configurable as { thread_id: string; checkpoint_ns: string };

    const checkpoint_id = generated.tuple.parentConfig?.configurable
      ?.checkpoint_id as string | undefined;

    const config = {
      configurable: {
        thread_id,
        checkpoint_ns,
        checkpoint_id,
      },
    };

    const existingTuple = await checkpointer.getTuple(generated.tuple.config);

    expect(existingTuple).toBeUndefined();

    const newConfig = await checkpointer.put(
      config,
      generated.tuple.checkpoint,
      generated.tuple.metadata!,
      generated.newVersions
    );

    for (const write of generated.writes) {
      await checkpointer.putWrites(newConfig, write.writes, write.taskId);
    }

    const expectedTuple = await checkpointer.getTuple(newConfig);

    expect(expectedTuple).not.toBeUndefined();

    if (expectedTuple) {
      yield expectedTuple;
    }
  }
}

export async function toArray(
  generator: AsyncGenerator<CheckpointTuple>
): Promise<CheckpointTuple[]> {
  const result = [];
  for await (const item of generator) {
    result.push(item);
  }
  return result;
}

export function toMap(tuples: CheckpointTuple[]): Map<string, CheckpointTuple> {
  const result = new Map<string, CheckpointTuple>();
  for (const item of tuples) {
    const key = item.checkpoint.id;
    result.set(key, item);
  }
  return result;
}

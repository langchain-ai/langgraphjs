import { mergeConfigs, RunnableConfig } from "@langchain/core/runnables";
import {
  ChannelVersions,
  CheckpointPendingWrite,
  PendingWrite,
  SendProtocol,
  TASKS,
  uuid6,
  type CheckpointTuple,
} from "@langchain/langgraph-checkpoint";

export interface InitialCheckpointTupleConfig {
  config: RunnableConfig;
  checkpoint_id: string;
  checkpoint_ns?: string;
  channel_values?: Record<string, unknown>;
  channel_versions?: ChannelVersions;
}
export function initialCheckpointTuple({
  config,
  checkpoint_id,
  checkpoint_ns,
  channel_values = {},
}: InitialCheckpointTupleConfig): CheckpointTuple {
  if (checkpoint_ns === undefined) {
    // eslint-disable-next-line no-param-reassign
    checkpoint_ns = config.configurable?.checkpoint_ns;
  }

  if (checkpoint_ns === undefined) {
    throw new Error("checkpoint_ns is required");
  }

  const channel_versions = Object.fromEntries(
    Object.keys(channel_values).map((key) => [key, 1])
  );

  return {
    config: mergeConfigs(config, {
      configurable: {
        checkpoint_id,
        checkpoint_ns,
      },
    }),
    checkpoint: {
      v: 1,
      ts: new Date().toISOString(),
      id: checkpoint_id,
      channel_values,
      channel_versions,
      versions_seen: {
        // I think this is meant to be opaque to checkpoint savers, so I'm just stuffing the data in here to make sure it's stored and retrieved
        "": {
          someChannel: 1,
        },
      },
      pending_sends: [],
    },

    metadata: {
      source: "input",
      step: -1,
      writes: null,
      parents: {},
    },
  };
}

export interface ParentAndChildCheckpointTuplesWithWritesConfig {
  config: RunnableConfig;
  parentCheckpointId: string;
  childCheckpointId: string;
  checkpoint_ns?: string;
  initialChannelValues?: Record<string, unknown>;
  writesToParent?: { taskId: string; writes: PendingWrite[] }[];
  writesToChild?: { taskId: string; writes: PendingWrite[] }[];
}

export function parentAndChildCheckpointTuplesWithWrites({
  config,
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
    // eslint-disable-next-line no-param-reassign
    checkpoint_ns = config.configurable?.checkpoint_ns;
  }

  if (checkpoint_ns === undefined) {
    throw new Error("checkpoint_ns is required");
  }

  const parentChannelVersions = Object.fromEntries(
    Object.keys(initialChannelValues).map((key) => [key, 1])
  );

  const pending_sends = writesToParent.flatMap(({ writes }) =>
    writes
      .filter(([channel]) => channel === TASKS)
      .map(([_, value]) => value as SendProtocol)
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
        v: 1,
        ts: new Date().toISOString(),
        id: parentCheckpointId,
        channel_values: initialChannelValues,
        channel_versions: parentChannelVersions,
        versions_seen: {
          // I think this is meant to be opaque to checkpoint savers, so I'm just stuffing the data in here to make sure it's stored and retrieved
          "": {
            someChannel: 1,
          },
        },
        pending_sends: [],
      },
      metadata: {
        source: "input",
        step: -1,
        writes: null,
        parents: {},
      },
      config: mergeConfigs(config, {
        configurable: {
          checkpoint_ns,
          checkpoint_id: parentCheckpointId,
        },
      }),
      parentConfig: undefined,
      pendingWrites: parentPendingWrites,
    },
    child: {
      checkpoint: {
        v: 2,
        ts: new Date().toISOString(),
        id: childCheckpointId,
        channel_values: childChannelValues,
        channel_versions: childChannelVersions,
        versions_seen: {
          // I think this is meant to be opaque to checkpoint savers, so I'm just stuffing the data in here to make sure it's stored and retrieved
          "": {
            someChannel: 1,
          },
        },
        pending_sends,
      },
      metadata: {
        source: "loop",
        step: 0,
        writes: {
          // I think this is meant to be opaque to checkpoint savers, so I'm just stuffing the data in here to make sure it's stored and retrieved
          someNode: parentPendingWrites,
        },
        parents: {
          // I think this is meant to be opaque to checkpoint savers, so I'm just stuffing the data in here to make sure it's stored and retrieved
          // I think this is roughly what it'd look like if it were generated by the pregel loop, though
          checkpoint_ns: parentCheckpointId,
        },
      },
      config: mergeConfigs(config, {
        configurable: {
          checkpoint_ns,
          checkpoint_id: childCheckpointId,
        },
      }),
      parentConfig: mergeConfigs(config, {
        configurable: {
          checkpoint_ns,
          checkpoint_id: parentCheckpointId,
        },
      }),
      pendingWrites: childPendingWrites,
    },
  };
}

export function* generateTuplePairs(
  config: RunnableConfig,
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
        config: mergeConfigs(config, {
          configurable: {
            thread_id,
            checkpoint_ns,
          },
        }),
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

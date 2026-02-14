/* eslint-disable no-param-reassign */
import {
  mergeConfigs,
  patchConfig,
  RunnableConfig,
} from "@langchain/core/runnables";
import { CallbackManagerForChainRun } from "@langchain/core/callbacks/manager";
import {
  All,
  BaseCheckpointSaver,
  Checkpoint,
  ReadonlyCheckpoint,
  copyCheckpoint,
  type PendingWrite,
  type PendingWriteValue,
  uuid5,
  maxChannelVersion,
  BaseStore,
  CheckpointPendingWrite,
  SendProtocol,
} from "@langchain/langgraph-checkpoint";
import {
  BaseChannel,
  createCheckpoint,
  emptyChannels,
  getOnlyChannels,
} from "../channels/base.js";
import { PregelNode } from "./read.js";
import { readChannel, readChannels } from "./io.js";
import {
  _isSend,
  _isSendInterface,
  CONFIG_KEY_CHECKPOINT_MAP,
  CHECKPOINT_NAMESPACE_SEPARATOR,
  CONFIG_KEY_CHECKPOINTER,
  CONFIG_KEY_READ,
  CONFIG_KEY_TASK_ID,
  CONFIG_KEY_SEND,
  INTERRUPT,
  RESERVED,
  Send,
  TAG_HIDDEN,
  TASKS,
  CHECKPOINT_NAMESPACE_END,
  PUSH,
  PULL,
  RESUME,
  NULL_TASK_ID,
  CONFIG_KEY_SCRATCHPAD,
  RETURN,
  ERROR,
  NO_WRITES,
  CONFIG_KEY_PREVIOUS_STATE,
  PREVIOUS,
  CACHE_NS_WRITES,
  CONFIG_KEY_RESUME_MAP,
  START,
} from "../constants.js";
import {
  Call,
  isCall,
  PregelExecutableTask,
  PregelScratchpad,
  PregelTaskDescription,
  SimpleTaskPath,
  TaskPath,
  VariadicTaskPath,
} from "./types.js";
import { EmptyChannelError, InvalidUpdateError } from "../errors.js";
import { getNullChannelVersion } from "./utils/index.js";
import { LangGraphRunnableConfig } from "./runnable_types.js";
import { getRunnableForFunc } from "./call.js";
import { IterableReadableWritableStream } from "./stream.js";
import { XXH3 } from "../hash.js";
import { Topic } from "../channels/topic.js";

// O(1) lookup set for RESERVED, used in hot paths instead of Array.includes
const RESERVED_SET: ReadonlySet<string> = new Set(RESERVED);

/**
 * Construct a type with a set of properties K of type T
 */
export type StrRecord<K extends string, T> = {
  [P in K]: T;
};

export type WritesProtocol<C = string> = {
  name: string;
  writes: PendingWrite<C>[];
  triggers: string[];
  path?: TaskPath;
};

export const increment = (current?: number) => {
  return current !== undefined ? current + 1 : 1;
};

function triggersNextStep(
  updatedChannels: Set<string>,
  triggerToNodes: Record<string, string[]> | undefined
) {
  if (triggerToNodes == null) return false;

  for (const chan of updatedChannels) {
    if (triggerToNodes[chan]) return true;
  }

  return false;
}

// Avoids unnecessary double iteration
function maxChannelMapVersion(
  channelVersions: Record<string, number | string>
): number | string | undefined {
  let maxVersion: number | string | undefined;
  for (const chan in channelVersions) {
    if (!Object.prototype.hasOwnProperty.call(channelVersions, chan)) continue;
    if (maxVersion == null) {
      maxVersion = channelVersions[chan];
    } else {
      maxVersion = maxChannelVersion(maxVersion, channelVersions[chan]);
    }
  }
  return maxVersion;
}

export function shouldInterrupt<N extends PropertyKey, C extends PropertyKey>(
  checkpoint: Checkpoint,
  interruptNodes: All | N[],
  tasks: PregelExecutableTask<N, C>[]
): boolean {
  const nullVersion = getNullChannelVersion(checkpoint.channel_versions);
  const seen = checkpoint.versions_seen[INTERRUPT] ?? {};

  let anyChannelUpdated = false;

  if (
    (checkpoint.channel_versions[START] ?? nullVersion) >
    (seen[START] ?? nullVersion)
  ) {
    anyChannelUpdated = true;
  } else {
    for (const chan in checkpoint.channel_versions) {
      if (
        !Object.prototype.hasOwnProperty.call(checkpoint.channel_versions, chan)
      )
        continue;

      if (checkpoint.channel_versions[chan] > (seen[chan] ?? nullVersion)) {
        anyChannelUpdated = true;
        break;
      }
    }
  }

  const anyTriggeredNodeInInterruptNodes = tasks.some((task) =>
    interruptNodes === "*"
      ? !task.config?.tags?.includes(TAG_HIDDEN)
      : interruptNodes.includes(task.name)
  );

  return anyChannelUpdated && anyTriggeredNodeInInterruptNodes;
}

export function _localRead<Cc extends Record<string, BaseChannel>>(
  checkpoint: ReadonlyCheckpoint,
  channels: Cc,
  task: WritesProtocol<keyof Cc>,
  select: Array<keyof Cc> | keyof Cc,
  fresh: boolean = false
): Record<string, unknown> | unknown {
  let updated = new Set<keyof Cc>();

  if (!Array.isArray(select)) {
    for (const [c] of task.writes) {
      if (c === select) {
        updated = new Set([c]);
        break;
      }
    }
    updated = updated || new Set();
  } else {
    updated = new Set(
      select.filter((c) => task.writes.some(([key, _]) => key === c))
    );
  }

  let values: Record<string, unknown>;

  if (fresh && updated.size > 0) {
    const localChannels = Object.fromEntries(
      Object.entries(channels).filter(([k, _]) => updated.has(k as keyof Cc))
    ) as Partial<Cc>;

    const newCheckpoint = createCheckpoint(checkpoint, localChannels as Cc, -1);
    const newChannels = emptyChannels(localChannels as Cc, newCheckpoint);

    _applyWrites(
      copyCheckpoint(newCheckpoint),
      newChannels,
      [task],
      undefined,
      undefined
    );
    values = readChannels({ ...channels, ...newChannels }, select);
  } else {
    values = readChannels(channels, select);
  }

  return values;
}

export function _localWrite(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  commit: (writes: [string, any][]) => any,
  processes: Record<string, PregelNode>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  writes: [string, any][]
) {
  for (const [chan, value] of writes) {
    if ([PUSH, TASKS].includes(chan) && value != null) {
      if (!_isSend(value)) {
        throw new InvalidUpdateError(
          `Invalid packet type, expected SendProtocol, got ${JSON.stringify(
            value
          )}`
        );
      }
      if (!(value.node in processes)) {
        throw new InvalidUpdateError(
          `Invalid node name "${value.node}" in Send packet`
        );
      }
    }
  }
  commit(writes);
}

const IGNORE = new Set<string | number | symbol>([
  NO_WRITES,
  PUSH,
  RESUME,
  INTERRUPT,
  RETURN,
  ERROR,
]);

export function _applyWrites<Cc extends Record<string, BaseChannel>>(
  checkpoint: Checkpoint,
  channels: Cc,
  tasks: WritesProtocol<keyof Cc>[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getNextVersion: ((version: any) => any) | undefined,
  triggerToNodes: Record<string, string[]> | undefined
): Set<string> {
  // Pre-compute paths once before sorting to avoid repeated .slice() allocations
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pathCache = new Map<WritesProtocol<keyof Cc>, any[]>();
  for (const task of tasks) {
    pathCache.set(task, task.path?.slice(0, 3) || []);
  }

  // Sort tasks by first 3 path elements for deterministic order
  // Later path parts (like task IDs) are ignored for sorting
  tasks.sort((a, b) => {
    const aPath = pathCache.get(a)!;
    const bPath = pathCache.get(b)!;

    // Compare each path element
    for (let i = 0; i < Math.min(aPath.length, bPath.length); i += 1) {
      if (aPath[i] < bPath[i]) return -1;
      if (aPath[i] > bPath[i]) return 1;
    }

    // If one path is shorter, it comes first
    return aPath.length - bPath.length;
  });

  // Filter out non instances of BaseChannel
  const onlyChannels = getOnlyChannels(channels);

  // Single pass: update seen versions, check for triggers, collect channels to consume
  let bumpStep = false;
  const channelsToConsume = new Set<string>();
  for (const task of tasks) {
    if (task.triggers.length > 0) bumpStep = true;
    checkpoint.versions_seen[task.name] ??= {};
    for (const chan of task.triggers) {
      if (chan in checkpoint.channel_versions) {
        checkpoint.versions_seen[task.name][chan] =
          checkpoint.channel_versions[chan];
      }
      if (!RESERVED_SET.has(chan)) {
        channelsToConsume.add(chan);
      }
    }
  }

  // Find the highest version of all channels
  let maxVersion = maxChannelMapVersion(checkpoint.channel_versions);

  let usedNewVersion = false;
  for (const chan of channelsToConsume) {
    if (chan in onlyChannels && onlyChannels[chan].consume()) {
      if (getNextVersion !== undefined) {
        checkpoint.channel_versions[chan] = getNextVersion(maxVersion);
        usedNewVersion = true;
      }
    }
  }

  // Group writes by channel
  const pendingWritesByChannel = {} as Record<keyof Cc, PendingWriteValue[]>;
  for (const task of tasks) {
    for (const [chan, val] of task.writes) {
      if (IGNORE.has(chan)) {
        // do nothing
      } else if (chan in onlyChannels) {
        pendingWritesByChannel[chan] ??= [];
        pendingWritesByChannel[chan].push(val);
      }
    }
  }

  // Find the highest version of all channels
  if (maxVersion != null && getNextVersion != null) {
    maxVersion = usedNewVersion ? getNextVersion(maxVersion) : maxVersion;
  }

  const updatedChannels: Set<string> = new Set();
  // Apply writes to channels
  for (const [chan, vals] of Object.entries(pendingWritesByChannel)) {
    if (chan in onlyChannels) {
      const channel = onlyChannels[chan];
      let updated;
      try {
        updated = channel.update(vals);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (e: any) {
        if (e.name === InvalidUpdateError.unminifiable_name) {
          const wrappedError = new InvalidUpdateError(
            `Invalid update for channel "${chan}" with values ${JSON.stringify(
              vals
            )}: ${e.message}`
          );
          wrappedError.lc_error_code = e.lc_error_code;
          throw wrappedError;
        } else {
          throw e;
        }
      }
      if (updated && getNextVersion !== undefined) {
        checkpoint.channel_versions[chan] = getNextVersion(maxVersion);

        // unavailable channels can't trigger tasks, so don't add them
        if (channel.isAvailable()) updatedChannels.add(chan);
      }
    }
  }

  // Channels that weren't updated in this step are notified of a new step
  if (bumpStep) {
    for (const chan in onlyChannels) {
      if (!Object.prototype.hasOwnProperty.call(onlyChannels, chan)) continue;

      const channel = onlyChannels[chan];
      if (channel.isAvailable() && !updatedChannels.has(chan)) {
        const updated = channel.update([]);

        if (updated && getNextVersion !== undefined) {
          checkpoint.channel_versions[chan] = getNextVersion(maxVersion);

          // unavailable channels can't trigger tasks, so don't add them
          if (channel.isAvailable()) updatedChannels.add(chan);
        }
      }
    }
  }

  // If this is (tentatively) the last superstep, notify all channels of finish
  if (bumpStep && !triggersNextStep(updatedChannels, triggerToNodes)) {
    for (const chan in onlyChannels) {
      if (!Object.prototype.hasOwnProperty.call(onlyChannels, chan)) continue;

      const channel = onlyChannels[chan];
      if (channel.finish() && getNextVersion !== undefined) {
        checkpoint.channel_versions[chan] = getNextVersion(maxVersion);

        // unavailable channels can't trigger tasks, so don't add them
        if (channel.isAvailable()) updatedChannels.add(chan);
      }
    }
  }

  return updatedChannels;
}

function* candidateNodes(
  checkpoint: ReadonlyCheckpoint,
  processes: StrRecord<string, PregelNode>,
  extra: NextTaskExtraFields
) {
  // This section is an optimization that allows which
  // nodes will be active during the next step.
  // When there's information about:
  // 1. Which channels were updated in the previous step
  // 2. Which nodes are triggered by which channels
  // Then we can determine which nodes should be triggered
  // in the next step without having to cycle through all nodes.
  if (extra.updatedChannels != null && extra.triggerToNodes != null) {
    const triggeredNodes = new Set<string>();

    // Get all nodes that have triggers associated with an updated channel
    for (const channel of extra.updatedChannels) {
      const nodeIds = extra.triggerToNodes[channel];
      for (const id of nodeIds ?? []) triggeredNodes.add(id);
    }

    // Sort the nodes to ensure deterministic order
    // Use Array.from + explicit loop to avoid intermediate spread allocation
    const sorted = Array.from(triggeredNodes).sort();
    for (let i = 0; i < sorted.length; i += 1) yield sorted[i];
    return;
  }

  // If there are no values in checkpoint, no need to run
  // through all the PULL candidates
  const isEmptyChannelVersions = (() => {
    for (const chan in checkpoint.channel_versions) {
      if (checkpoint.channel_versions[chan] !== null) return false;
    }
    return true;
  })();

  if (isEmptyChannelVersions) return;
  for (const name in processes) {
    if (!Object.prototype.hasOwnProperty.call(processes, name)) continue;
    yield name;
  }
}

/**
 * Pre-indexed pending writes for O(1) lookups, avoiding repeated
 * linear scans in _prepareSingleTask and _scratchpad.
 */
export type PendingWritesIndex = {
  nullResume: unknown | undefined;
  resumeByTaskId: Map<string, unknown[]>;
  successfulWriteTaskIds: Set<string>;
};

/**
 * Build an index over pendingWrites for O(1) lookups.
 */
function _indexPendingWrites(
  pendingWrites: [string, string, unknown][] | undefined
): PendingWritesIndex {
  let nullResume: unknown | undefined;
  const resumeByTaskId = new Map<string, unknown[]>();
  const successfulWriteTaskIds = new Set<string>();
  if (pendingWrites) {
    for (const [tid, chan, val] of pendingWrites) {
      if (tid === NULL_TASK_ID && chan === RESUME && nullResume === undefined) {
        nullResume = val;
      }
      if (chan === RESUME && tid !== NULL_TASK_ID) {
        let arr = resumeByTaskId.get(tid);
        if (!arr) {
          arr = [];
          resumeByTaskId.set(tid, arr);
        }
        arr.push(val);
      }
      if (chan !== ERROR) {
        successfulWriteTaskIds.add(tid);
      }
    }
  }
  return { nullResume, resumeByTaskId, successfulWriteTaskIds };
}

export type NextTaskExtraFields = {
  step: number;
  isResuming?: boolean;
  checkpointer?: BaseCheckpointSaver;
  manager?: CallbackManagerForChainRun;
  store?: BaseStore;
  stream?: IterableReadableWritableStream;
  triggerToNodes?: Record<string, string[]>;
  updatedChannels?: Set<string>;
  pendingWritesIndex?: PendingWritesIndex;
};

export type NextTaskExtraFieldsWithStore = NextTaskExtraFields & {
  store?: BaseStore;
};

export type NextTaskExtraFieldsWithoutStore = NextTaskExtraFields & {
  store?: never;
};

export function _prepareNextTasks<
  Nn extends StrRecord<string, PregelNode>,
  Cc extends StrRecord<string, BaseChannel>
>(
  checkpoint: ReadonlyCheckpoint,
  pendingWrites: [string, string, unknown][] | undefined,
  processes: Nn,
  channels: Cc,
  config: RunnableConfig,
  forExecution: false,
  extra: NextTaskExtraFieldsWithoutStore
): Record<string, PregelTaskDescription>;

export function _prepareNextTasks<
  Nn extends StrRecord<string, PregelNode>,
  Cc extends StrRecord<string, BaseChannel>
>(
  checkpoint: ReadonlyCheckpoint,
  pendingWrites: [string, string, unknown][] | undefined,
  processes: Nn,
  channels: Cc,
  config: RunnableConfig,
  forExecution: true,
  extra: NextTaskExtraFieldsWithStore
): Record<string, PregelExecutableTask<keyof Nn, keyof Cc>>;

/**
 * Prepare the set of tasks that will make up the next Pregel step.
 * This is the union of all PUSH tasks (Sends) and PULL tasks (nodes triggered
 * by edges).
 */
export function _prepareNextTasks<
  Nn extends StrRecord<string, PregelNode>,
  Cc extends StrRecord<string, BaseChannel>
>(
  checkpoint: ReadonlyCheckpoint,
  pendingWrites: [string, string, unknown][] | undefined,
  processes: Nn,
  channels: Cc,
  config: RunnableConfig,
  forExecution: boolean,
  extra: NextTaskExtraFieldsWithStore | NextTaskExtraFieldsWithoutStore
):
  | Record<string, PregelTaskDescription>
  | Record<string, PregelExecutableTask<keyof Nn, keyof Cc>> {
  const tasks:
    | Record<string, PregelExecutableTask<keyof Nn, keyof Cc>>
    | Record<string, PregelTaskDescription> = {};

  // Pre-index pendingWrites once for O(1) lookups in _prepareSingleTask/_scratchpad
  const indexedExtra: typeof extra = extra.pendingWritesIndex
    ? extra
    : { ...extra, pendingWritesIndex: _indexPendingWrites(pendingWrites) };

  // Consume pending tasks
  const tasksChannel = channels[TASKS] as Topic<SendProtocol> | undefined;

  if (tasksChannel?.isAvailable()) {
    const len = tasksChannel.get().length;
    for (let i = 0; i < len; i += 1) {
      const task = _prepareSingleTask(
        [PUSH, i],
        checkpoint,
        pendingWrites,
        processes,
        channels,
        config,
        forExecution,
        indexedExtra
      );
      if (task !== undefined) {
        tasks[task.id] = task;
      }
    }
  }

  // Check if any processes should be run in next step
  // If so, prepare the values to be passed to them
  for (const name of candidateNodes(checkpoint, processes, indexedExtra)) {
    const task = _prepareSingleTask(
      [PULL, name],
      checkpoint,
      pendingWrites,
      processes,
      channels,
      config,
      forExecution,
      indexedExtra
    );
    if (task !== undefined) {
      tasks[task.id] = task;
    }
  }
  return tasks;
}

export function _prepareSingleTask<
  Nn extends StrRecord<string, PregelNode>,
  Cc extends StrRecord<string, BaseChannel>
>(
  taskPath: SimpleTaskPath,
  checkpoint: ReadonlyCheckpoint,
  pendingWrites: CheckpointPendingWrite[] | undefined,
  processes: Nn,
  channels: Cc,
  config: RunnableConfig,
  forExecution: false,
  extra: NextTaskExtraFields
): PregelTaskDescription | undefined;

export function _prepareSingleTask<
  Nn extends StrRecord<string, PregelNode>,
  Cc extends StrRecord<string, BaseChannel>
>(
  taskPath: TaskPath,
  checkpoint: ReadonlyCheckpoint,
  pendingWrites: CheckpointPendingWrite[] | undefined,
  processes: Nn,
  channels: Cc,
  config: RunnableConfig,
  forExecution: true,
  extra: NextTaskExtraFields
): PregelExecutableTask<keyof Nn, keyof Cc> | undefined;

export function _prepareSingleTask<
  Nn extends StrRecord<string, PregelNode>,
  Cc extends StrRecord<string, BaseChannel>
>(
  taskPath: TaskPath,
  checkpoint: ReadonlyCheckpoint,
  pendingWrites: CheckpointPendingWrite[] | undefined,
  processes: Nn,
  channels: Cc,
  config: RunnableConfig,
  forExecution: boolean,
  extra: NextTaskExtraFieldsWithStore
): PregelTaskDescription | PregelExecutableTask<keyof Nn, keyof Cc> | undefined;

/**
 * Prepares a single task for the next Pregel step, given a task path, which
 * uniquely identifies a PUSH or PULL task within the graph.
 */
export function _prepareSingleTask<
  Nn extends StrRecord<string, PregelNode>,
  Cc extends StrRecord<string, BaseChannel>
>(
  taskPath: TaskPath,
  checkpoint: ReadonlyCheckpoint,
  pendingWrites: CheckpointPendingWrite[] | undefined,
  processes: Nn,
  channels: Cc,
  config: LangGraphRunnableConfig,
  forExecution: boolean,
  extra: NextTaskExtraFields
):
  | PregelTaskDescription
  | PregelExecutableTask<keyof Nn, keyof Cc>
  | undefined {
  const { step, checkpointer, manager } = extra;
  const configurable = config.configurable ?? {};
  const parentNamespace = configurable.checkpoint_ns ?? "";

  if (taskPath[0] === PUSH && isCall(taskPath[taskPath.length - 1])) {
    const call = taskPath[taskPath.length - 1] as Call;
    const proc = getRunnableForFunc(call.name, call.func);
    const triggers = [PUSH];
    const checkpointNamespace =
      parentNamespace === ""
        ? call.name
        : `${parentNamespace}${CHECKPOINT_NAMESPACE_SEPARATOR}${call.name}`;
    const id = uuid5(
      JSON.stringify([
        checkpointNamespace,
        step.toString(),
        call.name,
        PUSH,
        taskPath[1],
        taskPath[2],
      ]),
      checkpoint.id
    );
    const taskCheckpointNamespace = `${checkpointNamespace}${CHECKPOINT_NAMESPACE_END}${id}`;

    // we append `true` to the task path to indicate that a call is being made
    // so we should not return interrupts from this task (responsibility lies with the parent)
    const outputTaskPath = [...taskPath.slice(0, 3), true] as VariadicTaskPath;
    const metadata = {
      langgraph_step: step,
      langgraph_node: call.name,
      langgraph_triggers: triggers,
      langgraph_path: outputTaskPath,
      langgraph_checkpoint_ns: taskCheckpointNamespace,
    };
    if (forExecution) {
      const writes: [keyof Cc, unknown][] = [];
      const task = {
        name: call.name,
        input: call.input,
        proc,
        writes,
        config: patchConfig(
          mergeConfigs(config, {
            metadata,
            store: extra.store ?? config.store,
          }),
          {
            runName: call.name,
            callbacks: manager?.getChild(`graph:step:${step}`),
            configurable: {
              [CONFIG_KEY_TASK_ID]: id,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              [CONFIG_KEY_SEND]: (writes_: PendingWrite[]) =>
                _localWrite(
                  (items: PendingWrite<keyof Cc>[]) => writes.push(...items),
                  processes,
                  writes_
                ),
              [CONFIG_KEY_READ]: (
                select_: Array<keyof Cc> | keyof Cc,
                fresh_: boolean = false
              ) =>
                _localRead(
                  checkpoint,
                  channels,
                  {
                    name: call.name,
                    writes: writes as PendingWrite[],
                    triggers,
                    path: outputTaskPath,
                  },
                  select_,
                  fresh_
                ),
              [CONFIG_KEY_CHECKPOINTER]:
                checkpointer ?? configurable[CONFIG_KEY_CHECKPOINTER],
              [CONFIG_KEY_CHECKPOINT_MAP]: {
                ...configurable[CONFIG_KEY_CHECKPOINT_MAP],
                [parentNamespace]: checkpoint.id,
              },
              [CONFIG_KEY_SCRATCHPAD]: _scratchpad({
                pendingWrites: pendingWrites ?? [],
                taskId: id,
                currentTaskInput: call.input,
                resumeMap: config.configurable?.[CONFIG_KEY_RESUME_MAP],
                namespaceHash: XXH3(taskCheckpointNamespace),
                pendingWritesIndex: extra.pendingWritesIndex,
              }),
              [CONFIG_KEY_PREVIOUS_STATE]: checkpoint.channel_values[PREVIOUS],
              checkpoint_id: undefined,
              checkpoint_ns: taskCheckpointNamespace,
            },
          }
        ),
        triggers,
        retry_policy: call.retry,
        cache_key: call.cache
          ? {
              key: XXH3((call.cache.keyFunc ?? JSON.stringify)([call.input])),
              ns: [CACHE_NS_WRITES, call.name ?? "__dynamic__"],
              ttl: call.cache.ttl,
            }
          : undefined,
        id,
        path: outputTaskPath,
        writers: [],
      } satisfies PregelExecutableTask<keyof Nn, keyof Cc>;
      return task;
    } else {
      return {
        id,
        name: call.name,
        interrupts: [],
        path: outputTaskPath,
      };
    }
  } else if (taskPath[0] === PUSH) {
    const index =
      typeof taskPath[1] === "number"
        ? taskPath[1]
        : parseInt(taskPath[1] as string, 10);

    if (!channels[TASKS]?.isAvailable()) {
      return undefined;
    }

    const sends = channels[TASKS].get() as SendProtocol[];
    if (index < 0 || index >= sends.length) {
      return undefined;
    }

    const packet =
      _isSendInterface(sends[index]) && !_isSend(sends[index])
        ? new Send(sends[index].node, sends[index].args)
        : sends[index];

    if (!_isSendInterface(packet)) {
      console.warn(
        `Ignoring invalid packet ${JSON.stringify(packet)} in pending sends.`
      );
      return undefined;
    }
    if (!(packet.node in processes)) {
      console.warn(
        `Ignoring unknown node name ${packet.node} in pending sends.`
      );
      return undefined;
    }
    const triggers = [PUSH];
    const checkpointNamespace =
      parentNamespace === ""
        ? packet.node
        : `${parentNamespace}${CHECKPOINT_NAMESPACE_SEPARATOR}${packet.node}`;
    const taskId = uuid5(
      JSON.stringify([
        checkpointNamespace,
        step.toString(),
        packet.node,
        PUSH,
        index.toString(),
      ]),
      checkpoint.id
    );
    const taskCheckpointNamespace = `${checkpointNamespace}${CHECKPOINT_NAMESPACE_END}${taskId}`;
    let metadata = {
      langgraph_step: step,
      langgraph_node: packet.node,
      langgraph_triggers: triggers,
      langgraph_path: taskPath.slice(0, 3),
      langgraph_checkpoint_ns: taskCheckpointNamespace,
    };
    if (forExecution) {
      const proc = processes[packet.node];
      const node = proc.getNode();
      if (node !== undefined) {
        if (proc.metadata !== undefined) {
          metadata = { ...metadata, ...proc.metadata };
        }
        const writes: [keyof Cc, unknown][] = [];
        return {
          name: packet.node,
          input: packet.args,
          proc: node,
          subgraphs: proc.subgraphs,
          writes,
          config: patchConfig(
            mergeConfigs(config, {
              metadata,
              tags: proc.tags,
              store: extra.store ?? config.store,
            }),
            {
              runName: packet.node,
              callbacks: manager?.getChild(`graph:step:${step}`),
              configurable: {
                [CONFIG_KEY_TASK_ID]: taskId,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                [CONFIG_KEY_SEND]: (writes_: PendingWrite[]) =>
                  _localWrite(
                    (items: PendingWrite<keyof Cc>[]) => writes.push(...items),
                    processes,
                    writes_
                  ),
                [CONFIG_KEY_READ]: (
                  select_: Array<keyof Cc> | keyof Cc,
                  fresh_: boolean = false
                ) =>
                  _localRead(
                    checkpoint,
                    channels,
                    {
                      name: packet.node,
                      writes: writes as PendingWrite[],
                      triggers,
                      path: taskPath,
                    },
                    select_,
                    fresh_
                  ),
                [CONFIG_KEY_CHECKPOINTER]:
                  checkpointer ?? configurable[CONFIG_KEY_CHECKPOINTER],
                [CONFIG_KEY_CHECKPOINT_MAP]: {
                  ...configurable[CONFIG_KEY_CHECKPOINT_MAP],
                  [parentNamespace]: checkpoint.id,
                },
                [CONFIG_KEY_SCRATCHPAD]: _scratchpad({
                  pendingWrites: pendingWrites ?? [],
                  taskId,
                  currentTaskInput: packet.args,
                  resumeMap: config.configurable?.[CONFIG_KEY_RESUME_MAP],
                  namespaceHash: XXH3(taskCheckpointNamespace),
                  pendingWritesIndex: extra.pendingWritesIndex,
                }),
                [CONFIG_KEY_PREVIOUS_STATE]:
                  checkpoint.channel_values[PREVIOUS],
                checkpoint_id: undefined,
                checkpoint_ns: taskCheckpointNamespace,
              },
            }
          ),
          triggers,
          retry_policy: proc.retryPolicy,
          cache_key: proc.cachePolicy
            ? {
                key: XXH3(
                  (proc.cachePolicy.keyFunc ?? JSON.stringify)([packet.args])
                ),
                ns: [CACHE_NS_WRITES, proc.name ?? "__dynamic__", packet.node],
                ttl: proc.cachePolicy.ttl,
              }
            : undefined,
          id: taskId,
          path: taskPath,
          writers: proc.getWriters(),
        } satisfies PregelExecutableTask<keyof Nn, keyof Cc>;
      }
    } else {
      return {
        id: taskId,
        name: packet.node,
        interrupts: [],
        path: taskPath,
      } satisfies PregelTaskDescription;
    }
  } else if (taskPath[0] === PULL) {
    const name = taskPath[1].toString();
    const proc = processes[name];
    if (proc === undefined) {
      return undefined;
    }

    // Hoist checkpointNamespace — used by both early-exit check and main path
    const checkpointNamespace =
      parentNamespace === ""
        ? name
        : `${parentNamespace}${CHECKPOINT_NAMESPACE_SEPARATOR}${name}`;

    // Pre-compute the shared JSON prefix for uuid5 calls (reused by
    // early-exit check and main-path task ID to avoid double-serializing
    // the same 4-element array)
    const taskIdPrefixJson = JSON.stringify([
      checkpointNamespace,
      step.toString(),
      name,
      PULL,
    ]);
    // Remove trailing ']' to allow appending the differing last element
    const taskIdPrefixBase = `${taskIdPrefixJson.slice(0, -1)},`;

    // Check if this task already has successful writes in the pending writes.
    // Only compute the early-exit taskId when the index is available for O(1)
    // lookup. Without the index, the uuid5+JSON.stringify cost exceeds the
    // benefit of the linear scan it replaces.
    if (pendingWrites?.length && extra.pendingWritesIndex) {
      const taskId = uuid5(
        `${taskIdPrefixBase}${JSON.stringify(name)}]`,
        checkpoint.id
      );

      if (extra.pendingWritesIndex.successfulWriteTaskIds.has(taskId)) {
        return undefined;
      }
    }

    const nullVersion = getNullChannelVersion(checkpoint.channel_versions);
    if (nullVersion === undefined) {
      return undefined;
    }
    const seen = checkpoint.versions_seen[name] ?? {};

    // Find the first trigger that is available and has a new version
    const trigger = proc.triggers.find((chan) => {
      if (!channels[chan].isAvailable()) return false;

      return (
        (checkpoint.channel_versions[chan] ?? nullVersion) >
        (seen[chan] ?? nullVersion)
      );
    });

    // If any of the channels read by this process were updated
    if (trigger !== undefined) {
      const val = _procInput(proc, channels, forExecution);
      if (val === undefined) {
        return undefined;
      }
      const taskId = uuid5(
        `${taskIdPrefixBase}${JSON.stringify([trigger])}]`,
        checkpoint.id
      );
      const taskCheckpointNamespace = `${checkpointNamespace}${CHECKPOINT_NAMESPACE_END}${taskId}`;
      let metadata = {
        langgraph_step: step,
        langgraph_node: name,
        langgraph_triggers: [trigger],
        langgraph_path: taskPath,
        langgraph_checkpoint_ns: taskCheckpointNamespace,
      };
      if (forExecution) {
        const node = proc.getNode();
        if (node !== undefined) {
          if (proc.metadata !== undefined) {
            metadata = { ...metadata, ...proc.metadata };
          }
          const writes: [keyof Cc, unknown][] = [];
          return {
            name,
            input: val,
            proc: node,
            subgraphs: proc.subgraphs,
            writes,
            config: patchConfig(
              mergeConfigs(config, {
                metadata,
                tags: proc.tags,
                store: extra.store ?? config.store,
              }),
              {
                runName: name,
                callbacks: manager?.getChild(`graph:step:${step}`),
                configurable: {
                  [CONFIG_KEY_TASK_ID]: taskId,
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  [CONFIG_KEY_SEND]: (writes_: PendingWrite[]) =>
                    _localWrite(
                      (items: PendingWrite<keyof Cc>[]) => {
                        writes.push(...items);
                      },
                      processes,
                      writes_
                    ),
                  [CONFIG_KEY_READ]: (
                    select_: Array<keyof Cc> | keyof Cc,
                    fresh_: boolean = false
                  ) =>
                    _localRead(
                      checkpoint,
                      channels,
                      {
                        name,
                        writes: writes as PendingWrite[],
                        triggers: [trigger],
                        path: taskPath,
                      },
                      select_,
                      fresh_
                    ),
                  [CONFIG_KEY_CHECKPOINTER]:
                    checkpointer ?? configurable[CONFIG_KEY_CHECKPOINTER],
                  [CONFIG_KEY_CHECKPOINT_MAP]: {
                    ...configurable[CONFIG_KEY_CHECKPOINT_MAP],
                    [parentNamespace]: checkpoint.id,
                  },
                  [CONFIG_KEY_SCRATCHPAD]: _scratchpad({
                    pendingWrites: pendingWrites ?? [],
                    taskId,
                    currentTaskInput: val,
                    resumeMap: config.configurable?.[CONFIG_KEY_RESUME_MAP],
                    namespaceHash: XXH3(taskCheckpointNamespace),
                    pendingWritesIndex: extra.pendingWritesIndex,
                  }),
                  [CONFIG_KEY_PREVIOUS_STATE]:
                    checkpoint.channel_values[PREVIOUS],
                  checkpoint_id: undefined,
                  checkpoint_ns: taskCheckpointNamespace,
                },
              }
            ),
            triggers: [trigger],
            retry_policy: proc.retryPolicy,
            cache_key: proc.cachePolicy
              ? {
                  key: XXH3(
                    (proc.cachePolicy.keyFunc ?? JSON.stringify)([val])
                  ),
                  ns: [CACHE_NS_WRITES, proc.name ?? "__dynamic__", name],
                  ttl: proc.cachePolicy.ttl,
                }
              : undefined,
            id: taskId,
            path: taskPath,
            writers: proc.getWriters(),
          } satisfies PregelExecutableTask<keyof Nn, keyof Cc>;
        }
      } else {
        return {
          id: taskId,
          name,
          interrupts: [],
          path: taskPath,
        } satisfies PregelTaskDescription;
      }
    }
  }
  return undefined;
}

/**
 *  Function injected under CONFIG_KEY_READ in task config, to read current state.
 *  Used by conditional edges to read a copy of the state with reflecting the writes
 *  from that node only.
 *
 * @internal
 */
function _procInput(
  proc: PregelNode,
  channels: StrRecord<string, BaseChannel>,
  forExecution: boolean
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let val: any;

  if (typeof proc.channels === "object" && !Array.isArray(proc.channels)) {
    val = {};
    for (const [k, chan] of Object.entries(proc.channels)) {
      if (proc.triggers.includes(chan)) {
        try {
          val[k] = readChannel(channels, chan, false);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (e: any) {
          if (e.name === EmptyChannelError.unminifiable_name) {
            return undefined;
          } else {
            throw e;
          }
        }
      } else if (chan in channels) {
        try {
          val[k] = readChannel(channels, chan, false);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (e: any) {
          if (e.name === EmptyChannelError.unminifiable_name) {
            continue;
          } else {
            throw e;
          }
        }
      }
    }
  } else if (Array.isArray(proc.channels)) {
    let successfulRead = false;
    for (const chan of proc.channels) {
      try {
        val = readChannel(channels, chan, false);
        successfulRead = true;
        break;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (e: any) {
        if (e.name === EmptyChannelError.unminifiable_name) {
          continue;
        } else {
          throw e;
        }
      }
    }
    if (!successfulRead) {
      return undefined;
    }
  } else {
    throw new Error(
      `Invalid channels type, expected list or dict, got ${proc.channels}`
    );
  }

  // If the process has a mapper, apply it to the value
  if (forExecution && proc.mapper !== undefined) {
    val = proc.mapper(val);
  }

  return val;
}

/**
 * Remove any values belonging to UntrackedValue channels from a Send packet
 * before checkpointing.
 *
 * Send is often called with state to be passed to the destination node,
 * which may contain UntrackedValues at the top level.
 *
 * @internal
 */
export function sanitizeUntrackedValuesInSend(
  packet: Send,
  channels: StrRecord<string, BaseChannel>
): Send {
  if (typeof packet.args !== "object" || packet.args === null) {
    // Not a dict-like arg
    return packet;
  }

  // Top-level keys should be channel names
  const sanitizedArg: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(packet.args)) {
    const channel = channels[key];
    // Check if channel is an UntrackedValue by its lc_graph_name
    if (!channel || channel.lc_graph_name !== "UntrackedValue") {
      sanitizedArg[key] = value;
    }
  }

  return new Send(packet.node, sanitizedArg);
}

function _scratchpad({
  pendingWrites,
  taskId,
  currentTaskInput,
  resumeMap,
  namespaceHash,
  pendingWritesIndex,
}: {
  pendingWrites: CheckpointPendingWrite[];
  taskId: string;
  currentTaskInput: unknown;
  resumeMap: Record<string, unknown> | undefined;
  namespaceHash: string;
  pendingWritesIndex?: PendingWritesIndex;
}): PregelScratchpad {
  // Use pre-indexed values when available, fall back to scanning
  const nullResume = pendingWritesIndex
    ? pendingWritesIndex.nullResume
    : pendingWrites.find(
        ([writeTaskId, chan]) => writeTaskId === NULL_TASK_ID && chan === RESUME
      )?.[2];

  const resume = (() => {
    // Note: the original flatMap flattens array resume values one level,
    // so we must also flatten when using the pre-indexed values
    const result: unknown[] = pendingWritesIndex
      ? (pendingWritesIndex.resumeByTaskId.get(taskId) ?? []).flat()
      : pendingWrites
          .filter(
            ([writeTaskId, chan]) => writeTaskId === taskId && chan === RESUME
          )
          .flatMap(([_writeTaskId, _chan, resume]) => resume);

    if (resumeMap != null && namespaceHash in resumeMap) {
      const mappedResume = resumeMap[namespaceHash];
      result.push(mappedResume);
    }

    return result;
  })();

  const scratchpad = {
    callCounter: 0,
    interruptCounter: -1,
    resume,
    nullResume,
    subgraphCounter: 0,
    currentTaskInput,
    consumeNullResume: () => {
      if (scratchpad.nullResume) {
        delete scratchpad.nullResume;
        pendingWrites.splice(
          pendingWrites.findIndex(
            ([writeTaskId, chan]) =>
              writeTaskId === NULL_TASK_ID && chan === RESUME
          ),
          1
        );
        return nullResume;
      }

      return undefined;
    },
  };
  return scratchpad;
}

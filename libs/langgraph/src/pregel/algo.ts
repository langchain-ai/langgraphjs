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
} from "@langchain/langgraph-checkpoint";
import {
  BaseChannel,
  createCheckpoint,
  emptyChannels,
  isBaseChannel,
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
  CONFIG_KEY_RESUME_VALUE,
  NULL_TASK_ID,
  MISSING,
} from "../constants.js";
import { PregelExecutableTask, PregelTaskDescription } from "./types.js";
import { EmptyChannelError, InvalidUpdateError } from "../errors.js";
import { getNullChannelVersion } from "./utils/index.js";
import { ManagedValueMapping } from "../managed/base.js";
import { LangGraphRunnableConfig } from "./runnable_types.js";

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
};

export const increment = (current?: number) => {
  return current !== undefined ? current + 1 : 1;
};

export function shouldInterrupt<N extends PropertyKey, C extends PropertyKey>(
  checkpoint: Checkpoint,
  interruptNodes: All | N[],
  tasks: PregelExecutableTask<N, C>[]
): boolean {
  const versionValues = Object.values(checkpoint.channel_versions);
  const versionType =
    versionValues.length > 0 ? typeof versionValues[0] : undefined;
  let nullVersion: number | string;
  if (versionType === "number") {
    nullVersion = 0;
  } else if (versionType === "string") {
    nullVersion = "";
  }
  const seen = checkpoint.versions_seen[INTERRUPT] ?? {};

  const anyChannelUpdated = Object.entries(checkpoint.channel_versions).some(
    ([chan, version]) => {
      return version > (seen[chan] ?? nullVersion);
    }
  );

  const anyTriggeredNodeInInterruptNodes = tasks.some((task) =>
    interruptNodes === "*"
      ? !task.config?.tags?.includes(TAG_HIDDEN)
      : interruptNodes.includes(task.name)
  );

  return anyChannelUpdated && anyTriggeredNodeInInterruptNodes;
}

export function _localRead<Cc extends Record<string, BaseChannel>>(
  step: number,
  checkpoint: ReadonlyCheckpoint,
  channels: Cc,
  managed: ManagedValueMapping,
  task: WritesProtocol<keyof Cc>,
  select: Array<keyof Cc> | keyof Cc,
  fresh: boolean = false
): Record<string, unknown> | unknown {
  let managedKeys: Array<keyof Cc> = [];
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
    managedKeys = select.filter((k) => managed.get(k as string)) as Array<
      keyof Cc
    >;
    select = select.filter((k) => !managed.get(k as string)) as Array<keyof Cc>;
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

    _applyWrites(copyCheckpoint(newCheckpoint), newChannels, [task]);
    values = readChannels({ ...channels, ...newChannels }, select);
  } else {
    values = readChannels(channels, select);
  }

  if (managedKeys.length > 0) {
    for (const k of managedKeys) {
      const managedValue = managed.get(k as string);
      if (managedValue) {
        const resultOfManagedCall = managedValue.call(step);
        values[k as string] = resultOfManagedCall;
      }
    }
  }

  return values;
}

export function _localWrite(
  step: number,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  commit: (writes: [string, any][]) => any,
  processes: Record<string, PregelNode>,
  channels: Record<string, BaseChannel>,
  managed: ManagedValueMapping,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  writes: [string, any][]
) {
  for (const [chan, value] of writes) {
    if (chan === TASKS) {
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
      // replace any runtime values with placeholders
      managed.replaceRuntimeValues(step, value.args);
    } else if (!(chan in channels) && !managed.get(chan)) {
      console.warn(`Skipping write for channel '${chan}' which has no readers`);
    }
  }
  commit(writes);
}

const IGNORE = new Set<string | number | symbol>([PUSH, RESUME, INTERRUPT]);

export function _applyWrites<Cc extends Record<string, BaseChannel>>(
  checkpoint: Checkpoint,
  channels: Cc,
  tasks: WritesProtocol<keyof Cc>[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getNextVersion?: (version: any, channel: BaseChannel) => any
): Record<string, PendingWriteValue[]> {
  // if no task has triggers this is applying writes from the null task only
  // so we don't do anything other than update the channels written to
  const bumpStep = tasks.some((task) => task.triggers.length > 0);

  // Filter out non instances of BaseChannel
  const onlyChannels = Object.fromEntries(
    Object.entries(channels).filter(([_, value]) => isBaseChannel(value))
  ) as Cc;
  // Update seen versions
  for (const task of tasks) {
    if (checkpoint.versions_seen[task.name] === undefined) {
      checkpoint.versions_seen[task.name] = {};
    }
    for (const chan of task.triggers) {
      if (chan in checkpoint.channel_versions) {
        checkpoint.versions_seen[task.name][chan] =
          checkpoint.channel_versions[chan];
      }
    }
  }

  // Find the highest version of all channels
  let maxVersion: string | number | undefined;
  if (Object.keys(checkpoint.channel_versions).length > 0) {
    maxVersion = maxChannelVersion(
      ...Object.values(checkpoint.channel_versions)
    );
  }

  // Consume all channels that were read
  const channelsToConsume = new Set(
    tasks
      .flatMap((task) => task.triggers)
      .filter((chan) => !RESERVED.includes(chan))
  );

  for (const chan of channelsToConsume) {
    if (chan in onlyChannels && onlyChannels[chan].consume()) {
      if (getNextVersion !== undefined) {
        checkpoint.channel_versions[chan] = getNextVersion(
          maxVersion,
          onlyChannels[chan]
        );
      }
    }
  }

  // Clear pending sends
  if (checkpoint.pending_sends?.length && bumpStep) {
    checkpoint.pending_sends = [];
  }

  // Group writes by channel
  const pendingWriteValuesByChannel = {} as Record<
    keyof Cc,
    PendingWriteValue[]
  >;
  const pendingWritesByManaged = {} as Record<keyof Cc, PendingWriteValue[]>;
  for (const task of tasks) {
    for (const [chan, val] of task.writes) {
      if (IGNORE.has(chan)) {
        // do nothing
      } else if (chan === TASKS) {
        checkpoint.pending_sends.push({
          node: (val as Send).node,
          args: (val as Send).args,
        });
      } else if (chan in onlyChannels) {
        if (chan in pendingWriteValuesByChannel) {
          pendingWriteValuesByChannel[chan].push(val);
        } else {
          pendingWriteValuesByChannel[chan] = [val];
        }
      } else {
        if (chan in pendingWritesByManaged) {
          pendingWritesByManaged[chan].push(val);
        } else {
          pendingWritesByManaged[chan] = [val];
        }
      }
    }
  }

  // find the highest version of all channels
  maxVersion = undefined;
  if (Object.keys(checkpoint.channel_versions).length > 0) {
    maxVersion = maxChannelVersion(
      ...Object.values(checkpoint.channel_versions)
    );
  }

  const updatedChannels: Set<string> = new Set();
  // Apply writes to channels
  for (const [chan, vals] of Object.entries(pendingWriteValuesByChannel)) {
    if (chan in onlyChannels) {
      let updated;
      try {
        updated = onlyChannels[chan].update(vals);
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
        checkpoint.channel_versions[chan] = getNextVersion(
          maxVersion,
          onlyChannels[chan]
        );
      }
      updatedChannels.add(chan);
    }
  }

  // Channels that weren't updated in this step are notified of a new step
  if (bumpStep) {
    for (const chan of Object.keys(onlyChannels)) {
      if (!updatedChannels.has(chan)) {
        const updated = onlyChannels[chan].update([]);
        if (updated && getNextVersion !== undefined) {
          checkpoint.channel_versions[chan] = getNextVersion(
            maxVersion,
            onlyChannels[chan]
          );
        }
      }
    }
  }

  // Return managed values writes to be applied externally
  return pendingWritesByManaged;
}

export type NextTaskExtraFields = {
  step: number;
  isResuming?: boolean;
  checkpointer?: BaseCheckpointSaver;
  manager?: CallbackManagerForChainRun;
  store?: BaseStore;
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
  managed: ManagedValueMapping,
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
  managed: ManagedValueMapping,
  config: RunnableConfig,
  forExecution: true,
  extra: NextTaskExtraFieldsWithStore
): Record<string, PregelExecutableTask<keyof Nn, keyof Cc>>;

export function _prepareNextTasks<
  Nn extends StrRecord<string, PregelNode>,
  Cc extends StrRecord<string, BaseChannel>
>(
  checkpoint: ReadonlyCheckpoint,
  pendingWrites: [string, string, unknown][] | undefined,
  processes: Nn,
  channels: Cc,
  managed: ManagedValueMapping,
  config: RunnableConfig,
  forExecution: boolean,
  extra: NextTaskExtraFieldsWithStore | NextTaskExtraFieldsWithoutStore
):
  | Record<string, PregelTaskDescription>
  | Record<string, PregelExecutableTask<keyof Nn, keyof Cc>> {
  const tasks:
    | Record<string, PregelExecutableTask<keyof Nn, keyof Cc>>
    | Record<string, PregelTaskDescription> = {};
  // Consume pending packets
  for (let i = 0; i < checkpoint.pending_sends.length; i += 1) {
    const task = _prepareSingleTask(
      [PUSH, i],
      checkpoint,
      pendingWrites,
      processes,
      channels,
      managed,
      config,
      forExecution,
      extra
    );
    if (task !== undefined) {
      tasks[task.id] = task;
    }
  }
  // Check if any processes should be run in next step
  // If so, prepare the values to be passed to them
  for (const name of Object.keys(processes)) {
    const task = _prepareSingleTask(
      [PULL, name],
      checkpoint,
      pendingWrites,
      processes,
      channels,
      managed,
      config,
      forExecution,
      extra
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
  taskPath: [string, string | number],
  checkpoint: ReadonlyCheckpoint,
  pendingWrites: [string, string, unknown][] | undefined,
  processes: Nn,
  channels: Cc,
  managed: ManagedValueMapping,
  config: RunnableConfig,
  forExecution: false,
  extra: NextTaskExtraFields
): PregelTaskDescription | undefined;

export function _prepareSingleTask<
  Nn extends StrRecord<string, PregelNode>,
  Cc extends StrRecord<string, BaseChannel>
>(
  taskPath: [string, string | number],
  checkpoint: ReadonlyCheckpoint,
  pendingWrites: [string, string, unknown][] | undefined,
  processes: Nn,
  channels: Cc,
  managed: ManagedValueMapping,
  config: RunnableConfig,
  forExecution: true,
  extra: NextTaskExtraFields
): PregelExecutableTask<keyof Nn, keyof Cc> | undefined;

export function _prepareSingleTask<
  Nn extends StrRecord<string, PregelNode>,
  Cc extends StrRecord<string, BaseChannel>
>(
  taskPath: [string, string | number],
  checkpoint: ReadonlyCheckpoint,
  pendingWrites: [string, string, unknown][] | undefined,
  processes: Nn,
  channels: Cc,
  managed: ManagedValueMapping,
  config: RunnableConfig,
  forExecution: boolean,
  extra: NextTaskExtraFieldsWithStore
): PregelTaskDescription | PregelExecutableTask<keyof Nn, keyof Cc> | undefined;

export function _prepareSingleTask<
  Nn extends StrRecord<string, PregelNode>,
  Cc extends StrRecord<string, BaseChannel>
>(
  taskPath: [string, string | number],
  checkpoint: ReadonlyCheckpoint,
  pendingWrites: [string, string, unknown][] | undefined,
  processes: Nn,
  channels: Cc,
  managed: ManagedValueMapping,
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

  if (taskPath[0] === PUSH) {
    const index =
      typeof taskPath[1] === "number" ? taskPath[1] : parseInt(taskPath[1], 10);
    if (index >= checkpoint.pending_sends.length) {
      return undefined;
    }
    const packet = checkpoint.pending_sends[index];
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
      langgraph_path: taskPath,
      langgraph_checkpoint_ns: taskCheckpointNamespace,
    };
    if (forExecution) {
      const proc = processes[packet.node];
      const node = proc.getNode();
      if (node !== undefined) {
        managed.replaceRuntimePlaceholders(step, packet.args);
        if (proc.metadata !== undefined) {
          metadata = { ...metadata, ...proc.metadata };
        }
        const writes: [keyof Cc, unknown][] = [];
        const resume = pendingWrites?.find(
          (w) => [taskId, NULL_TASK_ID].includes(w[0]) && w[1] === RESUME
        );
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
                [CONFIG_KEY_SEND]: (writes_: [string, any][]) =>
                  _localWrite(
                    step,
                    (items: [keyof Cc, unknown][]) => writes.push(...items),
                    processes,
                    channels,
                    managed,
                    writes_
                  ),
                [CONFIG_KEY_READ]: (
                  select_: Array<keyof Cc> | keyof Cc,
                  fresh_: boolean = false
                ) =>
                  _localRead(
                    step,
                    checkpoint,
                    channels,
                    managed,
                    {
                      name: packet.node,
                      writes: writes as Array<[string, unknown]>,
                      triggers,
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
                [CONFIG_KEY_RESUME_VALUE]: resume ? resume[2] : MISSING,
                checkpoint_id: undefined,
                checkpoint_ns: taskCheckpointNamespace,
              },
            }
          ),
          triggers,
          retry_policy: proc.retryPolicy,
          id: taskId,
          path: taskPath,
        };
      }
    } else {
      return { id: taskId, name: packet.node, interrupts: [], path: taskPath };
    }
  } else if (taskPath[0] === PULL) {
    const name = taskPath[1].toString();
    const proc = processes[name];
    if (proc === undefined) {
      return undefined;
    }
    const nullVersion = getNullChannelVersion(checkpoint.channel_versions);
    if (nullVersion === undefined) {
      return undefined;
    }
    const seen = checkpoint.versions_seen[name] ?? {};
    const triggers = proc.triggers
      .filter((chan) => {
        const result = readChannel(channels, chan, false, true);
        const isEmptyChannelError =
          // eslint-disable-next-line no-instanceof/no-instanceof
          result instanceof Error &&
          result.name === EmptyChannelError.unminifiable_name;
        return (
          !isEmptyChannelError &&
          (checkpoint.channel_versions[chan] ?? nullVersion) >
            (seen[chan] ?? nullVersion)
        );
      })
      .sort();
    // If any of the channels read by this process were updated
    if (triggers.length > 0) {
      const val = _procInput(step, proc, managed, channels, forExecution);
      if (val === undefined) {
        return undefined;
      }
      const checkpointNamespace =
        parentNamespace === ""
          ? name
          : `${parentNamespace}${CHECKPOINT_NAMESPACE_SEPARATOR}${name}`;
      const taskId = uuid5(
        JSON.stringify([
          checkpointNamespace,
          step.toString(),
          name,
          PULL,
          triggers,
        ]),
        checkpoint.id
      );
      const taskCheckpointNamespace = `${checkpointNamespace}${CHECKPOINT_NAMESPACE_END}${taskId}`;
      let metadata = {
        langgraph_step: step,
        langgraph_node: name,
        langgraph_triggers: triggers,
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
          const resume = pendingWrites?.find(
            (w) => [taskId, NULL_TASK_ID].includes(w[0]) && w[1] === RESUME
          );
          const taskCheckpointNamespace = `${checkpointNamespace}${CHECKPOINT_NAMESPACE_END}${taskId}`;
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
                  [CONFIG_KEY_SEND]: (writes_: [string, any][]) =>
                    _localWrite(
                      step,
                      (items: [keyof Cc, unknown][]) => {
                        writes.push(...items);
                      },
                      processes,
                      channels,
                      managed,
                      writes_
                    ),
                  [CONFIG_KEY_READ]: (
                    select_: Array<keyof Cc> | keyof Cc,
                    fresh_: boolean = false
                  ) =>
                    _localRead(
                      step,
                      checkpoint,
                      channels,
                      managed,
                      {
                        name,
                        writes: writes as Array<[string, unknown]>,
                        triggers,
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
                  [CONFIG_KEY_RESUME_VALUE]: resume ? resume[2] : MISSING,
                  checkpoint_id: undefined,
                  checkpoint_ns: taskCheckpointNamespace,
                },
              }
            ),
            triggers,
            retry_policy: proc.retryPolicy,
            id: taskId,
            path: taskPath,
          };
        }
      } else {
        return { id: taskId, name, interrupts: [], path: taskPath };
      }
    }
  }
  return undefined;
}

function _procInput(
  step: number,
  proc: PregelNode,
  managed: ManagedValueMapping,
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
          val[k] = readChannel(channels, chan, true);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (e: any) {
          if (e.name === EmptyChannelError.unminifiable_name) {
            continue;
          } else {
            throw e;
          }
        }
      } else {
        val[k] = managed.get(k)?.call(step);
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

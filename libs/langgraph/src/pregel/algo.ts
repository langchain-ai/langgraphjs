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
} from "@langchain/langgraph-checkpoint";
import {
  BaseChannel,
  createCheckpoint,
  emptyChannels,
} from "../channels/base.js";
import { PregelNode } from "./read.js";
import { readChannel, readChannels } from "./io.js";
import {
  _isSend,
  _isSendInterface,
  CHECKPOINT_NAMESPACE_SEPARATOR,
  CONFIG_KEY_CHECKPOINTER,
  CONFIG_KEY_READ,
  CONFIG_KEY_RESUMING,
  CONFIG_KEY_SEND,
  INTERRUPT,
  RESERVED,
  Send,
  TAG_HIDDEN,
  TASKS,
} from "../constants.js";
import { PregelExecutableTask, PregelTaskDescription } from "./types.js";
import { EmptyChannelError, InvalidUpdateError } from "../errors.js";
import { _getIdMetadata, getNullChannelVersion } from "./utils.js";

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

export function _localRead<Cc extends StrRecord<string, BaseChannel>>(
  checkpoint: ReadonlyCheckpoint,
  channels: Cc,
  task: WritesProtocol<keyof Cc>,
  select: Array<keyof Cc> | keyof Cc,
  fresh: boolean = false
): Record<string, unknown> | unknown {
  if (fresh) {
    const newCheckpoint = createCheckpoint(checkpoint, channels, -1);
    // create a new copy of channels
    const newChannels = emptyChannels(channels, newCheckpoint);
    // Note: _applyWrites contains side effects
    _applyWrites(copyCheckpoint(newCheckpoint), newChannels, [task]);
    return readChannels(newChannels, select);
  } else {
    return readChannels(channels, select);
  }
}

export function _localWrite(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  commit: (writes: [string, any][]) => void,
  processes: Record<string, PregelNode>,
  channels: Record<string, BaseChannel>,
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
          `Invalid node name ${value.node} in packet`
        );
      }
    } else if (!(chan in channels)) {
      console.warn(`Skipping write for channel '${chan}' which has no readers`);
    }
  }
  commit(writes);
}

export function _applyWrites<Cc extends Record<string, BaseChannel>>(
  checkpoint: Checkpoint,
  channels: Cc,
  tasks: WritesProtocol<keyof Cc>[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getNextVersion?: (version: any, channel: BaseChannel) => any
): void {
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
  let maxVersion: number | undefined;
  if (Object.keys(checkpoint.channel_versions).length > 0) {
    maxVersion = Math.max(...Object.values(checkpoint.channel_versions));
  }

  // Consume all channels that were read
  const channelsToConsume = new Set(
    tasks
      .flatMap((task) => task.triggers)
      .filter((chan) => !RESERVED.includes(chan))
  );

  for (const chan of channelsToConsume) {
    if (channels[chan].consume()) {
      if (getNextVersion !== undefined) {
        checkpoint.channel_versions[chan] = getNextVersion(
          maxVersion,
          channels[chan]
        );
      }
    }
  }

  // Clear pending sends
  if (checkpoint.pending_sends) {
    checkpoint.pending_sends = [];
  }

  // Group writes by channel
  const pendingWriteValuesByChannel = {} as Record<
    keyof Cc,
    PendingWriteValue[]
  >;
  for (const task of tasks) {
    for (const [chan, val] of task.writes) {
      if (chan === TASKS) {
        checkpoint.pending_sends.push({
          node: (val as Send).node,
          args: (val as Send).args,
        });
      } else {
        if (chan in pendingWriteValuesByChannel) {
          pendingWriteValuesByChannel[chan].push(val);
        } else {
          pendingWriteValuesByChannel[chan] = [val];
        }
      }
    }
  }

  // find the highest version of all channels
  maxVersion = undefined;
  if (Object.keys(checkpoint.channel_versions).length > 0) {
    maxVersion = Math.max(...Object.values(checkpoint.channel_versions));
  }

  const updatedChannels: Set<string> = new Set();
  // Apply writes to channels
  for (const [chan, vals] of Object.entries(pendingWriteValuesByChannel)) {
    if (chan in channels) {
      let updated;
      try {
        updated = channels[chan].update(vals);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (e: any) {
        if (e.name === InvalidUpdateError.unminifiable_name) {
          throw new InvalidUpdateError(
            `Invalid update for channel ${chan} with values ${JSON.stringify(
              vals
            )}`
          );
        } else {
          throw e;
        }
      }
      if (updated && getNextVersion !== undefined) {
        checkpoint.channel_versions[chan] = getNextVersion(
          maxVersion,
          channels[chan]
        );
      }
      updatedChannels.add(chan);
    }
  }

  // Channels that weren't updated in this step are notified of a new step
  for (const chan of Object.keys(channels)) {
    if (!updatedChannels.has(chan)) {
      const updated = channels[chan].update([]);
      if (updated && getNextVersion !== undefined) {
        checkpoint.channel_versions[chan] = getNextVersion(
          maxVersion,
          channels[chan]
        );
      }
    }
  }
}

export type NextTaskExtraFields = {
  step: number;
  isResuming?: boolean;
  checkpointer?: BaseCheckpointSaver;
  manager?: CallbackManagerForChainRun;
};

export function _prepareNextTasks<
  Nn extends StrRecord<string, PregelNode>,
  Cc extends StrRecord<string, BaseChannel>
>(
  checkpoint: ReadonlyCheckpoint,
  processes: Nn,
  channels: Cc,
  config: RunnableConfig,
  forExecution: false,
  extra: NextTaskExtraFields
): PregelTaskDescription[];

export function _prepareNextTasks<
  Nn extends StrRecord<string, PregelNode>,
  Cc extends StrRecord<string, BaseChannel>
>(
  checkpoint: ReadonlyCheckpoint,
  processes: Nn,
  channels: Cc,
  config: RunnableConfig,
  forExecution: true,
  extra: NextTaskExtraFields
): PregelExecutableTask<keyof Nn, keyof Cc>[];

export function _prepareNextTasks<
  Nn extends StrRecord<string, PregelNode>,
  Cc extends StrRecord<string, BaseChannel>
>(
  checkpoint: ReadonlyCheckpoint,
  processes: Nn,
  channels: Cc,
  config: RunnableConfig,
  forExecution: boolean,
  extra: NextTaskExtraFields
): PregelTaskDescription[] | PregelExecutableTask<keyof Nn, keyof Cc>[] {
  const parentNamespace = config.configurable?.checkpoint_ns ?? "";
  const tasks: Array<PregelExecutableTask<keyof Nn, keyof Cc>> = [];
  const taskDescriptions: Array<PregelTaskDescription> = [];
  const { step, isResuming = false, checkpointer, manager } = extra;

  for (const packet of checkpoint.pending_sends) {
    if (!_isSendInterface(packet)) {
      console.warn(
        `Ignoring invalid packet ${JSON.stringify(packet)} in pending sends.`
      );
      continue;
    }
    if (!(packet.node in processes)) {
      console.warn(
        `Ignoring unknown node name ${packet.node} in pending sends.`
      );
      continue;
    }
    const triggers = [TASKS];
    const metadata = _getIdMetadata({
      langgraph_step: step,
      langgraph_node: packet.node,
      langgraph_triggers: triggers,
      langgraph_task_idx: forExecution ? tasks.length : taskDescriptions.length,
    });
    const checkpointNamespace =
      parentNamespace === ""
        ? packet.node
        : `${parentNamespace}${CHECKPOINT_NAMESPACE_SEPARATOR}${packet.node}`;
    const taskId = uuid5(
      JSON.stringify([checkpointNamespace, metadata]),
      checkpoint.id
    );

    if (forExecution) {
      const proc = processes[packet.node];
      const node = proc.getNode();
      if (node !== undefined) {
        const writes: [keyof Cc, unknown][] = [];
        tasks.push({
          name: packet.node,
          input: packet.args,
          proc: node,
          writes,
          triggers,
          config: patchConfig(
            mergeConfigs(config, processes[packet.node].config, {
              metadata,
            }),
            {
              runName: packet.node,
              callbacks: manager?.getChild(`graph:step:${step}`),
              configurable: {
                [CONFIG_KEY_SEND]: _localWrite.bind(
                  undefined,
                  (items: [keyof Cc, unknown][]) => writes.push(...items),
                  processes,
                  channels
                ),
                [CONFIG_KEY_READ]: _localRead.bind(
                  undefined,
                  checkpoint,
                  channels,
                  {
                    name: packet.node,
                    writes: writes as Array<[string, unknown]>,
                    triggers,
                  }
                ),
              },
            }
          ),
          id: taskId,
          retry_policy: proc.retryPolicy,
        });
      }
    } else {
      taskDescriptions.push({ id: taskId, name: packet.node });
    }
  }

  // Check if any processes should be run in next step
  // If so, prepare the values to be passed to them
  const nullVersion = getNullChannelVersion(checkpoint.channel_versions);
  if (nullVersion === undefined) {
    return forExecution ? tasks : taskDescriptions;
  }
  for (const [name, proc] of Object.entries<PregelNode>(processes)) {
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
      const val = _procInput(proc, channels, forExecution);
      if (val === undefined) {
        continue;
      }

      const metadata = _getIdMetadata({
        langgraph_step: step,
        langgraph_node: name,
        langgraph_triggers: triggers,
        langgraph_task_idx: forExecution
          ? tasks.length
          : taskDescriptions.length,
      });

      const checkpointNamespace =
        parentNamespace === ""
          ? name
          : `${parentNamespace}${CHECKPOINT_NAMESPACE_SEPARATOR}${name}`;

      const taskId = uuid5(
        JSON.stringify([checkpointNamespace, metadata]),
        checkpoint.id
      );

      if (forExecution) {
        const node = proc.getNode();
        if (node !== undefined) {
          const writes: [keyof Cc, unknown][] = [];
          tasks.push({
            name,
            input: val,
            proc: node,
            writes,
            triggers,
            config: patchConfig(
              mergeConfigs(config, proc.config, { metadata }),
              {
                runName: name,
                callbacks: manager?.getChild(`graph:step:${step}`),
                configurable: {
                  [CONFIG_KEY_SEND]: _localWrite.bind(
                    undefined,
                    (items: [keyof Cc, unknown][]) => writes.push(...items),
                    processes,
                    channels
                  ),
                  [CONFIG_KEY_READ]: _localRead.bind(
                    undefined,
                    checkpoint,
                    channels,
                    {
                      name,
                      writes: writes as Array<[string, unknown]>,
                      triggers,
                    }
                  ),
                  [CONFIG_KEY_CHECKPOINTER]: checkpointer,
                  [CONFIG_KEY_RESUMING]: isResuming,
                  checkpoint_id: checkpoint.id,
                  checkpoint_ns: checkpointNamespace,
                },
              }
            ),
            id: taskId,
            retry_policy: proc.retryPolicy,
          });
        }
      } else {
        taskDescriptions.push({ id: taskId, name });
      }
    }
  }
  return forExecution ? tasks : taskDescriptions;
}

function _procInput(
  proc: PregelNode,
  channels: StrRecord<string, BaseChannel>,
  forExecution: boolean
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let val: any;
  // If all trigger channels subscribed by this process are not empty
  // then invoke the process with the values of all non-empty channels
  if (Array.isArray(proc.channels)) {
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
      return;
    }
  } else if (typeof proc.channels === "object") {
    val = {};
    try {
      for (const [k, chan] of Object.entries(proc.channels)) {
        val[k] = readChannel(channels, chan, !proc.triggers.includes(chan));
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      if (e.name === EmptyChannelError.unminifiable_name) {
        return;
      } else {
        throw e;
      }
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

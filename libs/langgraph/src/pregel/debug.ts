import { RunnableConfig } from "@langchain/core/runnables";
import {
  CheckpointMetadata,
  CheckpointPendingWrite,
  PendingWrite,
  uuid5,
} from "@langchain/langgraph-checkpoint";
import { BaseChannel } from "../channels/base.js";
import { ERROR, TAG_HIDDEN, TASK_NAMESPACE } from "../constants.js";
import { EmptyChannelError } from "../errors.js";
import { PregelExecutableTask, PregelTaskDescription } from "./types.js";
import { readChannels } from "./io.js";
import { _getIdMetadata } from "./utils.js";

type ConsoleColors = {
  start: string;
  end: string;
};

type ConsoleColorMap = {
  [key: string]: ConsoleColors;
};

const COLORS_MAP: ConsoleColorMap = {
  blue: {
    start: "\x1b[34m",
    end: "\x1b[0m",
  },
  green: {
    start: "\x1b[32m",
    end: "\x1b[0m",
  },
  yellow: {
    start: "\x1b[33;1m",
    end: "\x1b[0m",
  },
};

/**
 * Wrap some text in a color for printing to the console.
 */
const wrap = (color: ConsoleColors, text: string): string =>
  `${color.start}${text}${color.end}`;

export function printCheckpoint<Value>(
  step: number,
  channels: Record<string, BaseChannel<Value>>
) {
  console.log(
    [
      `${wrap(COLORS_MAP.blue, "[langgraph/checkpoint]")}`,
      `Finishing step ${step}. Channel values:\n`,
      `\n${JSON.stringify(
        Object.fromEntries(_readChannels<Value>(channels)),
        null,
        2
      )}`,
    ].join("")
  );
}

function* _readChannels<Value>(
  channels: Record<string, BaseChannel<Value>>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): IterableIterator<[string, any]> {
  for (const [name, channel] of Object.entries(channels)) {
    try {
      yield [name, channel.get()];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      if (error.name === EmptyChannelError.unminifiable_name) {
        // Skip the channel if it's empty
        continue;
      } else {
        throw error; // Re-throw the error if it's not an EmptyChannelError
      }
    }
  }
}

export function* mapDebugTasks<N extends PropertyKey, C extends PropertyKey>(
  step: number,
  tasks: readonly PregelExecutableTask<N, C>[]
) {
  const ts = new Date().toISOString();
  for (const { name, input, config, triggers } of tasks) {
    if (config?.tags?.includes(TAG_HIDDEN)) continue;

    const metadata = { ...config?.metadata };
    const idMetadata = _getIdMetadata({
      langgraph_step: metadata.langgraph_step,
      langgraph_node: metadata.langgraph_node,
      langgraph_triggers: metadata.langgraph_triggers,
      langgraph_task_idx: metadata.langgraph_task_idx,
    });

    yield {
      type: "task",
      timestamp: ts,
      step,
      payload: {
        id: uuid5(JSON.stringify([name, step, idMetadata]), TASK_NAMESPACE),
        name,
        input,
        triggers,
      },
    };
  }
}

export function* mapDebugTaskResults<
  N extends PropertyKey,
  C extends PropertyKey
>(
  step: number,
  tasks: readonly PregelExecutableTask<N, C>[],
  streamChannelsList: Array<PropertyKey>
) {
  const ts = new Date().toISOString();
  for (const { name, writes, config } of tasks) {
    if (config?.tags?.includes(TAG_HIDDEN)) continue;

    const metadata = { ...config?.metadata };
    const idMetadata = _getIdMetadata(metadata);

    yield {
      type: "task_result",
      timestamp: ts,
      step,
      payload: {
        id: uuid5(JSON.stringify([name, step, idMetadata]), TASK_NAMESPACE),
        name,
        result: writes.filter(([channel]) =>
          streamChannelsList.includes(channel)
        ),
      },
    };
  }
}

export function* mapDebugCheckpoint<
  N extends PropertyKey,
  C extends PropertyKey
>(
  step: number,
  config: RunnableConfig,
  channels: Record<string, BaseChannel>,
  streamChannels: string | string[],
  metadata: CheckpointMetadata,
  tasks: readonly PregelExecutableTask<N, C>[],
  pendingWrites: CheckpointPendingWrite[]
) {
  function formatConfig(config: RunnableConfig) {
    // https://stackoverflow.com/a/78298178
    type CamelToSnake<
      T extends string,
      A extends string = ""
    > = T extends `${infer F}${infer R}`
      ? CamelToSnake<
          R,
          `${A}${F extends Lowercase<F> ? F : `_${Lowercase<F>}`}`
        >
      : A;

    // make sure the config is consistent with Python
    const pyConfig: Partial<
      Record<CamelToSnake<keyof RunnableConfig>, unknown>
    > = {};

    if (config.callbacks != null) pyConfig.callbacks = config.callbacks;
    if (config.configurable != null)
      pyConfig.configurable = config.configurable;
    if (config.maxConcurrency != null)
      pyConfig.max_concurrency = config.maxConcurrency;

    if (config.metadata != null) pyConfig.metadata = config.metadata;
    if (config.recursionLimit != null)
      pyConfig.recursion_limit = config.recursionLimit;
    if (config.runId != null) pyConfig.run_id = config.runId;
    if (config.runName != null) pyConfig.run_name = config.runName;
    if (config.tags != null) pyConfig.tags = config.tags;

    return pyConfig;
  }

  function getCurrentUTC() {
    const now = new Date();
    return new Date(now.getTime() - now.getTimezoneOffset() * 60 * 1000);
  }

  const ts = getCurrentUTC().toISOString();
  yield {
    type: "checkpoint",
    timestamp: ts,
    step,
    payload: {
      config: formatConfig(config),
      values: readChannels(channels, streamChannels),
      metadata,
      next: tasks.map((task) => task.name),
      tasks: tasksWithWrites(tasks, pendingWrites),
    },
  };
}

export function tasksWithWrites<N extends PropertyKey, C extends PropertyKey>(
  tasks: PregelTaskDescription[] | readonly PregelExecutableTask<N, C>[],
  pendingWrites: CheckpointPendingWrite[]
): PregelTaskDescription[] {
  return tasks.map((task): PregelTaskDescription => {
    const error = pendingWrites.find(
      ([id, n]) => id === task.id && n === ERROR
    )?.[2];

    if (error) return { id: task.id, name: task.name as string, error };
    return { id: task.id, name: task.name as string };
  });
}

export function printStepCheckpoint(
  step: number,
  channels: Record<string, BaseChannel<unknown>>,
  whitelist: string[]
): void {
  console.log(
    [
      `${wrap(COLORS_MAP.blue, `[${step}:checkpoint]`)}`,
      `\x1b[1m State at the end of step ${step}:\x1b[0m\n`,
      JSON.stringify(readChannels(channels, whitelist), null, 2),
    ].join("")
  );
}

export function printStepTasks<N extends PropertyKey, C extends PropertyKey>(
  step: number,
  nextTasks: readonly PregelExecutableTask<N, C>[]
): void {
  const nTasks = nextTasks.length;
  console.log(
    [
      `${wrap(COLORS_MAP.blue, `[${step}:tasks]`)}`,
      `\x1b[1m Starting step ${step} with ${nTasks} task${
        nTasks === 1 ? "" : "s"
      }:\x1b[0m\n`,
      nextTasks
        .map(
          (task) =>
            `- ${wrap(COLORS_MAP.green, String(task.name))} -> ${JSON.stringify(
              task.input,
              null,
              2
            )}`
        )
        .join("\n"),
    ].join("")
  );
}

export function printStepWrites(
  step: number,
  writes: PendingWrite[],
  whitelist: string[]
): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const byChannel: Record<string, any[]> = {};

  for (const [channel, value] of writes) {
    if (whitelist.includes(channel)) {
      if (!byChannel[channel]) {
        byChannel[channel] = [];
      }
      byChannel[channel].push(value);
    }
  }

  console.log(
    [
      `${wrap(COLORS_MAP.blue, `[${step}:writes]`)}`,
      `\x1b[1m Finished step ${step} with writes to ${
        Object.keys(byChannel).length
      } channel${Object.keys(byChannel).length !== 1 ? "s" : ""}:\x1b[0m\n`,
      Object.entries(byChannel)
        .map(
          ([name, vals]) =>
            `- ${wrap(COLORS_MAP.yellow, name)} -> ${vals
              .map((v) => JSON.stringify(v))
              .join(", ")}`
        )
        .join("\n"),
    ].join("")
  );
}

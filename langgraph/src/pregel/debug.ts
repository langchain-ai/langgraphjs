import { RunnableConfig } from "@langchain/core/runnables";
import { BaseChannel } from "../channels/base.js";
import { uuid5 } from "../checkpoint/id.js";
import { TAG_HIDDEN, TASK_NAMESPACE } from "../constants.js";
import { EmptyChannelError } from "../errors.js";
import { PregelExecutableTask } from "./types.js";
import { CheckpointMetadata } from "../web.js";
import { readChannels } from "./io.js";

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
};

/**
 * Wrap some text in a color for printing to the console.
 */
const wrap = (color: ConsoleColors, text: string): string =>
  `${color.start}${text}${color.end}`;

export function printStepStart<N extends PropertyKey, C extends PropertyKey>(
  step: number,
  nextTasks: readonly PregelExecutableTask<N, C>[]
): void {
  const nTasks = nextTasks.length;
  console.log(
    `${wrap(COLORS_MAP.blue, "[langgraph/step]")}`,
    `Starting step ${step} with ${nTasks} task${
      nTasks === 1 ? "" : "s"
    }. Next tasks:\n`,
    `\n${nextTasks
      .map(
        (task) => `${String(task.name)}(${JSON.stringify(task.input, null, 2)})`
      )
      .join("\n")}`
  );
}

export function printCheckpoint<Value>(
  step: number,
  channels: Record<string, BaseChannel<Value>>
) {
  console.log(
    `${wrap(COLORS_MAP.blue, "[langgraph/checkpoint]")}`,
    `Finishing step ${step}. Channel values:\n`,
    `\n${JSON.stringify(
      Object.fromEntries(_readChannels<Value>(channels)),
      null,
      2
    )}`
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
    delete metadata.checkpoint_id;

    yield {
      type: "task",
      timestamp: ts,
      step,
      payload: {
        id: uuid5(JSON.stringify([name, step, metadata]), TASK_NAMESPACE),
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
    delete metadata.checkpoint_id;

    yield {
      type: "task_result",
      timestamp: ts,
      step,
      payload: {
        id: uuid5(JSON.stringify([name, step, metadata]), TASK_NAMESPACE),
        name,
        result: writes.filter(([channel]) =>
          streamChannelsList.includes(channel)
        ),
      },
    };
  }
}

export function* mapDebugCheckpoint(
  step: number,
  config: RunnableConfig,
  channels: Record<string, BaseChannel>,
  streamChannels: string | string[],
  metadata: CheckpointMetadata
) {
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
      config,
      values: readChannels(channels, streamChannels),
      metadata,
    },
  };
}

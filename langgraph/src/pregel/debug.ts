import { BaseChannel } from "../channels/base.js";
import { EmptyChannelError } from "../errors.js";
import { PregelExecutableTask } from "./types.js";

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

import { BaseChannel, EmptyChannelError } from "../channels/base.js";
import { PregelExecutableTask } from "./types.js";
import { TAG_HIDDEN } from "../constants.js";

export function readChannel(
  channels: Record<string, BaseChannel>,
  chan: string,
  catch_: boolean = true,
  returnException: boolean = false
): unknown | null {
  try {
    return channels[chan].get();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (e: any) {
    if (e.name === EmptyChannelError.name) {
      if (returnException) {
        return e;
      } else if (catch_) {
        return null;
      }
    }
    throw e;
  }
}

export function readChannels(
  channels: Record<string, BaseChannel>,
  select: string[] | string,
  skipEmpty: boolean = true
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Record<string, any> | any {
  if (typeof select === "string") {
    return readChannel(channels, select);
  } else {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const values: Record<string, any> = {};
    for (const k of select) {
      try {
        values[k] = readChannel(channels, k, !skipEmpty);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (e: any) {
        if (e.name === EmptyChannelError.name) {
          continue;
        }
      }
    }
    return values;
  }
}

/**
 * Map input chunk to a sequence of pending writes in the form [channel, value].
 */
export function* mapInput<C extends PropertyKey>(
  inputChannels: C | Array<C>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  chunk?: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Generator<[C, any]> {
  if (chunk) {
    if (
      Array.isArray(inputChannels) &&
      typeof chunk === "object" &&
      !Array.isArray(chunk) &&
      !!chunk
    ) {
      for (const k in chunk) {
        if (inputChannels.includes(k as C)) {
          yield [k as C, chunk[k]];
        }
      }
    } else if (Array.isArray(inputChannels)) {
      throw new Error(
        "Input chunk must be an object when inputChannels is an array"
      );
    } else {
      yield [inputChannels, chunk];
    }
  }
}

/**
 * Map pending writes (a sequence of tuples (channel, value)) to output chunk.
 */
export function* mapOutputValues(
  outputChannels: string | Array<string>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pendingWrites: Array<[string, any]>,
  channels: Record<string, BaseChannel>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Generator<[Record<string, any>, any]> {
  if (typeof outputChannels === "string") {
    if (pendingWrites.some(([chan, _]) => chan === outputChannels)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      yield readChannel(channels, outputChannels) as any;
    }
  } else {
    if (pendingWrites.find(([chan, _]) => outputChannels.includes(chan))) {
      yield readChannels(channels, outputChannels);
    }
  }
}

/**
 * Map pending writes (a sequence of tuples (channel, value)) to output chunk.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function* mapOutputUpdates(
  outputChannels: string | Array<string>,
  tasks: Array<PregelExecutableTask>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Generator<Record<string, any | Record<string, any>>> {
  const outputTasks = tasks.filter(
    (task) =>
      task.config === undefined || !task.config.tags?.includes(TAG_HIDDEN)
  );
  if (typeof outputChannels === "string") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updated: Record<string, any | Record<string, any>> = {};

    for (const task of outputTasks) {
      for (const [chan, value] of task.writes) {
        if (chan === outputChannels) {
          updated[task.name] = value;
        }
      }
    }

    yield updated;
  } else {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updated: Record<string, any | Record<string, any>> = {};

    for (const task of outputTasks) {
      if (task.writes.some(([chan, _]) => outputChannels.includes(chan))) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const nodes: Record<string, any> = {};
        for (const [chan, value] of task.writes) {
          if (outputChannels.includes(chan)) {
            nodes[chan] = value;
          }
        }

        updated[task.name] = nodes;
      }
    }

    yield updated;
  }
}

/**
 * Map pending writes (a list of [channel, value]) to output chunk.
 */
export function mapOutput<Cc extends Record<string, BaseChannel>>(
  outputChannels: keyof Cc | Array<keyof Cc>,
  pendingWrites: Array<[keyof Cc, unknown]>,
  channels: Cc
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any | undefined {
  if (!Array.isArray(outputChannels)) {
    if (pendingWrites.some(([chan, _]) => chan === outputChannels)) {
      return channels[outputChannels].get();
    }
  } else {
    const updated = pendingWrites
      .filter(([chan, _]) => outputChannels.includes(chan))
      .map(([chan, _]) => chan);
    if (updated.length > 0) {
      return updated.reduce((acc, chan) => {
        acc[chan] = channels[chan].get();
        return acc;
      }, {} as Record<keyof Cc, unknown>);
    }
  }
  return undefined;
}

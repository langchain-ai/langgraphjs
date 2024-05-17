import { BaseChannel } from "../channels/base.js";
import { PregelExecutableTask } from "./types.js";
import { TAG_HIDDEN } from "../constants.js";
import { EmptyChannelError } from "../errors.js";

export function readChannel<C extends PropertyKey>(
  channels: Record<C, BaseChannel>,
  chan: C,
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

export function readChannels<C extends PropertyKey>(
  channels: Record<C, BaseChannel>,
  select: C | Array<C>,
  skipEmpty: boolean = true
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Record<string, any> | any {
  if (Array.isArray(select)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const values = {} as Record<C, any>;
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
  } else {
    return readChannel(channels, select);
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
  if (chunk !== undefined && chunk !== null) {
    if (
      Array.isArray(inputChannels) &&
      typeof chunk === "object" &&
      !Array.isArray(chunk)
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
export function* mapOutputValues<C extends PropertyKey>(
  outputChannels: C | Array<C>,
  pendingWrites: readonly [C, unknown][],
  channels: Record<C, BaseChannel>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Generator<Record<string, any>, any> {
  if (Array.isArray(outputChannels)) {
    if (pendingWrites.find(([chan, _]) => outputChannels.includes(chan))) {
      yield readChannels(channels, outputChannels);
    }
  } else {
    if (pendingWrites.some(([chan, _]) => chan === outputChannels)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      yield readChannel(channels, outputChannels) as any;
    }
  }
}

/**
 * Map pending writes (a sequence of tuples (channel, value)) to output chunk.
 */
export function* mapOutputUpdates<N extends PropertyKey, C extends PropertyKey>(
  outputChannels: C | Array<C>,
  tasks: readonly PregelExecutableTask<N, C>[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Generator<Record<N, any | Record<string, any>>> {
  const outputTasks = tasks.filter(
    (task) =>
      task.config === undefined || !task.config.tags?.includes(TAG_HIDDEN)
  );
  if (Array.isArray(outputChannels)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updated = {} as Record<N, any | Record<string, any>>;

    for (const task of outputTasks) {
      if (task.writes.some(([chan, _]) => outputChannels.includes(chan as C))) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const nodes = {} as Record<C, any>;
        for (const [chan, value] of task.writes) {
          if (outputChannels.includes(chan as C)) {
            nodes[chan] = value;
          }
        }

        updated[task.name] = nodes;
      }
    }

    if (Object.keys(updated).length > 0) {
      yield updated;
    }
  } else {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updated = {} as Record<N, any | Record<string, any>>;

    for (const task of outputTasks) {
      for (const [chan, value] of task.writes) {
        if (chan === outputChannels) {
          updated[task.name] = value;
        }
      }
    }

    if (Object.keys(updated).length > 0) {
      yield updated;
    }
  }
}

export function single<T>(iter: IterableIterator<T>): T | undefined {
  // eslint-disable-next-line no-unreachable-loop
  for (const value of iter) {
    return value;
  }
  return undefined;
}

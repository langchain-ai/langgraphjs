import type { PendingWrite } from "@langchain/langgraph-checkpoint";
import { validate } from "uuid";

import type { BaseChannel } from "../channels/base.js";
import type { PregelExecutableTask } from "./types.js";
import { Command, NULL_TASK_ID, RESUME, TAG_HIDDEN } from "../constants.js";
import { EmptyChannelError } from "../errors.js";

export function readChannel<C extends PropertyKey>(
  channels: Record<C, BaseChannel>,
  chan: C,
  catchErrors: boolean = true,
  returnException: boolean = false
): unknown | null {
  try {
    return channels[chan].get();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (e: any) {
    if (e.name === EmptyChannelError.unminifiable_name) {
      if (returnException) {
        return e;
      } else if (catchErrors) {
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
        if (e.name === EmptyChannelError.unminifiable_name) {
          continue;
        }
      }
    }
    return values;
  } else {
    return readChannel(channels, select);
  }
}

export function* mapCommand(
  cmd: Command
): Generator<[string, string, unknown]> {
  if (cmd.resume) {
    if (
      typeof cmd.resume === "object" &&
      !!cmd.resume &&
      Object.keys(cmd.resume).length &&
      Object.keys(cmd.resume).every(validate)
    ) {
      for (const [tid, resume] of Object.entries(cmd.resume)) {
        yield [tid, RESUME, resume];
      }
    } else {
      yield [NULL_TASK_ID, RESUME, cmd.resume];
    }
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
        `Input chunk must be an object when "inputChannels" is an array`
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
  pendingWrites: readonly PendingWrite<C>[] | true,
  channels: Record<C, BaseChannel>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Generator<Record<string, any>, any> {
  if (Array.isArray(outputChannels)) {
    if (
      pendingWrites === true ||
      pendingWrites.find(([chan, _]) => outputChannels.includes(chan))
    ) {
      yield readChannels(channels, outputChannels);
    }
  } else {
    if (
      pendingWrites === true ||
      pendingWrites.some(([chan, _]) => chan === outputChannels)
    ) {
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
  tasks: readonly [PregelExecutableTask<N, C>, PendingWrite<C>[]][],
  cached?: boolean
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Generator<Record<N, Record<string, any> | any>> {
  const outputTasks = tasks.filter(([task]) => {
    return task.config === undefined || !task.config.tags?.includes(TAG_HIDDEN);
  });
  if (!outputTasks.length) {
    return;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let updated: [N, Record<string, any>][];
  if (!Array.isArray(outputChannels)) {
    updated = outputTasks.flatMap(([task]) =>
      task.writes
        .filter(([chan, _]) => chan === outputChannels)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map(([_, value]) => [task.name, value] as [N, Record<string, any>])
    );
  } else {
    updated = outputTasks
      .filter(([task]) =>
        task.writes.some(([chan]) => outputChannels.includes(chan))
      )
      .map(([task]) => [
        task.name,
        Object.fromEntries(
          task.writes.filter(([chan]) => outputChannels.includes(chan))
        ),
      ]);
  }
  const grouped = Object.fromEntries(
    outputTasks.map(([t]) => [t.name, []])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ) as unknown as Record<N, Record<string, any>>;

  for (const [node, value] of updated) {
    grouped[node].push(value);
  }

  for (const [node, value] of Object.entries(grouped) as [
    N,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Record<string, any>[]
  ][]) {
    if (value.length === 0) {
      delete grouped[node];
    } else if (value.length === 1) {
      // TODO: Fix incorrect cast here
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      grouped[node] = value[0] as Record<string, any>[];
    }
  }
  if (cached) {
    grouped["__metadata__" as N] = { cached };
  }
  yield grouped;
}

export function single<T>(iter: IterableIterator<T>): T | null {
  // eslint-disable-next-line no-unreachable-loop
  for (const value of iter) {
    return value;
  }
  return null;
}

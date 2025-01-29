import type {
  CheckpointPendingWrite,
  PendingWrite,
} from "@langchain/langgraph-checkpoint";
import { validate } from "uuid";

import type { BaseChannel } from "../channels/base.js";
import type { PregelExecutableTask } from "./types.js";
import {
  _isSend,
  Command,
  ERROR,
  INTERRUPT,
  NULL_TASK_ID,
  RESUME,
  RETURN,
  SELF,
  TAG_HIDDEN,
  TASKS,
} from "../constants.js";
import { EmptyChannelError, InvalidUpdateError } from "../errors.js";

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

/**
 * Map input chunk to a sequence of pending writes in the form (channel, value).
 */
export function* mapCommand(
  cmd: Command,
  pendingWrites: CheckpointPendingWrite[]
): Generator<[string, string, unknown]> {
  if (cmd.graph === Command.PARENT) {
    throw new InvalidUpdateError("There is no parent graph.");
  }
  if (cmd.goto) {
    let sends;
    if (Array.isArray(cmd.goto)) {
      sends = cmd.goto;
    } else {
      sends = [cmd.goto];
    }
    for (const send of sends) {
      if (_isSend(send)) {
        yield [NULL_TASK_ID, TASKS, send];
      } else if (typeof send === "string") {
        yield [NULL_TASK_ID, `branch:__start__:${SELF}:${send}`, "__start__"];
      } else {
        throw new Error(
          `In Command.send, expected Send or string, got ${typeof send}`
        );
      }
    }
  }
  if (cmd.resume) {
    if (
      typeof cmd.resume === "object" &&
      Object.keys(cmd.resume).length &&
      Object.keys(cmd.resume).every(validate)
    ) {
      for (const [tid, resume] of Object.entries(cmd.resume)) {
        const existing =
          pendingWrites
            .filter((w) => w[0] === tid && w[1] === RESUME)
            .map((w) => w[2])
            .slice(0, 1) ?? [];
        existing.push(resume);
        yield [tid, RESUME, existing];
      }
    } else {
      yield [NULL_TASK_ID, RESUME, cmd.resume];
    }
  }
  if (cmd.update) {
    if (typeof cmd.update !== "object" || !cmd.update) {
      throw new Error(
        "Expected cmd.update to be a dict mapping channel names to update values"
      );
    }

    if (Array.isArray(cmd.update)) {
      for (const [k, v] of cmd.update) {
        yield [NULL_TASK_ID, k, v];
      }
    } else {
      for (const [k, v] of Object.entries(cmd.update)) {
        yield [NULL_TASK_ID, k, v];
      }
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
  const outputTasks = tasks.filter(([task, ww]) => {
    return (
      (task.config === undefined || !task.config.tags?.includes(TAG_HIDDEN)) &&
      ww[0][0] !== ERROR &&
      ww[0][0] !== INTERRUPT
    );
  });
  if (!outputTasks.length) {
    return;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let updated: [N, Record<string, any>][];
  if (
    outputTasks.some(([task]) =>
      task.writes.some(([chan, _]) => chan === RETURN)
    )
  ) {
    updated = outputTasks.flatMap(([task]) =>
      task.writes
        .filter(([chan, _]) => chan === RETURN)
        .map(([_, value]) => [task.name, value] as [N, Record<string, unknown>])
    );
  } else if (!Array.isArray(outputChannels)) {
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

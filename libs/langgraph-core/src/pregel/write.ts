import {
  Runnable,
  RunnableConfig,
  RunnableLike,
} from "@langchain/core/runnables";
import { _isSend, CONFIG_KEY_SEND, Send, TASKS } from "../constants.js";
import { RunnableCallable } from "../utils.js";
import { InvalidUpdateError } from "../errors.js";

type TYPE_SEND = (values: Array<[string, unknown]>) => void;

export const SKIP_WRITE = {
  [Symbol.for("LG_SKIP_WRITE")]: true,
};

function _isSkipWrite(x: unknown) {
  return (
    typeof x === "object" &&
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (x as any)?.[Symbol.for("LG_SKIP_WRITE")] !== undefined
  );
}

export const PASSTHROUGH = {
  [Symbol.for("LG_PASSTHROUGH")]: true,
};

function _isPassthrough(x: unknown) {
  return (
    typeof x === "object" &&
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (x as any)?.[Symbol.for("LG_PASSTHROUGH")] !== undefined
  );
}

const IS_WRITER = Symbol("IS_WRITER");

/**
 * Mapping of write channels to Runnables that return the value to be written,
 * or None to skip writing.
 */
export class ChannelWrite<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  RunInput = any
> extends RunnableCallable<RunInput, RunInput> {
  writes: Array<ChannelWriteEntry | ChannelWriteTupleEntry | Send>;

  constructor(
    writes: Array<ChannelWriteEntry | ChannelWriteTupleEntry | Send>,
    tags?: string[]
  ) {
    const name = `ChannelWrite<${writes
      .map((packet) => {
        if (_isSend(packet)) {
          return packet.node;
        } else if ("channel" in packet) {
          return packet.channel;
        }
        return "...";
      })
      .join(",")}>`;
    super({
      ...{ writes, name, tags },
      trace: false,
      func: async (input: RunInput, config?: RunnableConfig) => {
        return this._write(input, config ?? {});
      },
    });

    this.writes = writes;
  }

  async _write(input: unknown, config: RunnableConfig): Promise<unknown> {
    const writes = this.writes.map((write) => {
      if (_isChannelWriteTupleEntry(write) && _isPassthrough(write.value)) {
        return {
          mapper: write.mapper,
          value: input,
        };
      } else if (_isChannelWriteEntry(write) && _isPassthrough(write.value)) {
        return {
          channel: write.channel,
          value: input,
          skipNone: write.skipNone,
          mapper: write.mapper,
        };
      } else {
        return write;
      }
    });
    await ChannelWrite.doWrite(config, writes);
    return input;
  }

  // TODO: Support requireAtLeastOneOf
  static async doWrite(
    config: RunnableConfig,
    writes: (ChannelWriteEntry | ChannelWriteTupleEntry | Send)[]
  ): Promise<void> {
    // validate
    for (const w of writes) {
      if (_isChannelWriteEntry(w)) {
        if (w.channel === TASKS) {
          throw new InvalidUpdateError(
            "Cannot write to the reserved channel TASKS"
          );
        }
        if (_isPassthrough(w.value)) {
          throw new InvalidUpdateError("PASSTHROUGH value must be replaced");
        }
      }
      if (_isChannelWriteTupleEntry(w)) {
        if (_isPassthrough(w.value)) {
          throw new InvalidUpdateError("PASSTHROUGH value must be replaced");
        }
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const writeEntries: [string, any][] = [];
    for (const w of writes) {
      if (_isSend(w)) {
        writeEntries.push([TASKS, w]);
      } else if (_isChannelWriteTupleEntry(w)) {
        const mappedResult = await w.mapper.invoke(w.value, config);
        if (mappedResult != null && mappedResult.length > 0) {
          writeEntries.push(...mappedResult);
        }
      } else if (_isChannelWriteEntry(w)) {
        const mappedValue =
          w.mapper !== undefined
            ? await w.mapper.invoke(w.value, config)
            : w.value;
        if (_isSkipWrite(mappedValue)) {
          continue;
        }
        if (w.skipNone && mappedValue === undefined) {
          continue;
        }
        writeEntries.push([w.channel, mappedValue]);
      } else {
        throw new Error(`Invalid write entry: ${JSON.stringify(w)}`);
      }
    }
    const write: TYPE_SEND = config.configurable?.[CONFIG_KEY_SEND];
    write(writeEntries);
  }

  static isWriter(runnable: RunnableLike): runnable is ChannelWrite {
    return (
      // eslint-disable-next-line no-instanceof/no-instanceof
      runnable instanceof ChannelWrite ||
      (IS_WRITER in runnable && !!runnable[IS_WRITER])
    );
  }

  static registerWriter<T extends Runnable>(runnable: T): T {
    return Object.defineProperty(runnable, IS_WRITER, { value: true });
  }
}

export interface ChannelWriteEntry {
  channel: string;
  value: unknown;
  skipNone?: boolean;
  mapper?: Runnable;
}

function _isChannelWriteEntry(x: unknown): x is ChannelWriteEntry {
  return (
    x !== undefined && typeof (x as ChannelWriteEntry).channel === "string"
  );
}

export interface ChannelWriteTupleEntry {
  value: unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mapper: Runnable<any, [string, any][]>;
}

function _isChannelWriteTupleEntry(x: unknown): x is ChannelWriteTupleEntry {
  return (
    x !== undefined &&
    !_isChannelWriteEntry(x) &&
    Runnable.isRunnable((x as ChannelWriteTupleEntry).mapper)
  );
}

import {
  Runnable,
  RunnableConfig,
  RunnableLike,
} from "@langchain/core/runnables";
import {
  _isSend,
  CONFIG_KEY_SEND,
  FF_SEND_V2,
  PUSH,
  Send,
  TASKS,
} from "../constants.js";
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
> extends RunnableCallable {
  writes: Array<ChannelWriteEntry | Send>;

  constructor(writes: Array<ChannelWriteEntry | Send>, tags?: string[]) {
    const name = `ChannelWrite<${writes
      .map((packet) => {
        return _isSend(packet) ? packet.node : packet.channel;
      })
      .join(",")}>`;
    super({
      ...{ writes, name, tags },
      func: async (input: RunInput, config?: RunnableConfig) => {
        return this._write(input, config ?? {});
      },
    });

    this.writes = writes;
  }

  // async _getWriteValues(
  //   input: unknown,
  //   config: RunnableConfig
  // ): Promise<(string | Send)[]> {

  // }

  async _write(input: unknown, config: RunnableConfig): Promise<unknown> {
    const writes = this.writes.map((write) => {
      if (_isChannelWriteEntry(write) && write.value === PASSTHROUGH) {
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
    ChannelWrite.doWrite(config, writes);
    return input;
  }

  // TODO: Support requireAtLeastOneOf
  static async doWrite(
    config: RunnableConfig,
    writes: (ChannelWriteEntry | Send)[]
  ): Promise<void> {
    const sends: [string, Send][] = writes.filter(_isSend).map((packet) => {
      return [FF_SEND_V2 ? PUSH : TASKS, packet];
    });
    const entries = writes.filter((write): write is ChannelWriteEntry => {
      return !_isSend(write);
    });
    const invalidEntry = entries.find((write) => {
      return write.channel === TASKS || write.channel === PUSH;
    });
    if (invalidEntry) {
      throw new InvalidUpdateError(
        `Cannot write to the reserved channels ${TASKS} or ${PUSH}`
      );
    }
    const values: [string, unknown][] = await Promise.all(
      entries.map(async (write: ChannelWriteEntry) => {
        const mappedValue = write.mapper
          ? await write.mapper.invoke(write.value, config)
          : write.value;
        return {
          ...write,
          value: mappedValue,
        };
      })
    ).then((writes: Array<ChannelWriteEntry>) => {
      return writes
        .filter(
          (write: ChannelWriteEntry) => !write.skipNone || write.value !== null
        )
        .map((write) => {
          return [write.channel, write.value];
        });
    });
    const write: TYPE_SEND = config.configurable?.[CONFIG_KEY_SEND];
    const filtered = values.filter(([_, value]) => !_isSkipWrite(value));
    write([...sends, ...filtered]);
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

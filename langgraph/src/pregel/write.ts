import {
  Runnable,
  RunnableConfig,
  RunnableLike,
} from "@langchain/core/runnables";
import { CONFIG_KEY_SEND } from "../constants.js";
import { RunnableCallable } from "../utils.js";

type TYPE_SEND = (values: Array<[string, unknown]>) => void;

export const SKIP_WRITE = {};
export const PASSTHROUGH = {};
const IS_WRITER = Symbol("IS_WRITER");

/**
 * Mapping of write channels to Runnables that return the value to be written,
 * or None to skip writing.
 */
export class ChannelWrite<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  RunInput = any
> extends RunnableCallable {
  writes: Array<ChannelWriteEntry>;

  constructor(writes: Array<ChannelWriteEntry>, tags?: string[]) {
    const name = `ChannelWrite<${writes
      .map(({ channel }) => channel)
      .join(",")}>`;
    super({
      ...{ writes, name, tags },
      func: async (input: RunInput, config?: RunnableConfig) =>
        this._write(input, config ?? {}),
    });

    this.writes = writes;
  }

  async _getWriteValues(
    input: unknown,
    config: RunnableConfig
  ): Promise<Record<string, unknown>> {
    return Promise.all(
      this.writes
        .map((write: ChannelWriteEntry) => ({
          channel: write.channel,
          value: write.value === PASSTHROUGH ? input : write.value,
          skipNone: write.skipNone,
          mapper: write.mapper,
        }))
        .map(async (write: ChannelWriteEntry) => ({
          channel: write.channel,
          value: write.mapper
            ? await write.mapper.invoke(write.value, config)
            : write.value,
          skipNone: write.skipNone,
          mapper: write.mapper,
        }))
    ).then((writes: Array<ChannelWriteEntry>) =>
      writes
        .filter(
          (write: ChannelWriteEntry) => !write.skipNone || write.value !== null
        )
        .reduce((acc: Record<string, unknown>, write: ChannelWriteEntry) => {
          acc[write.channel] = write.value;
          return acc;
        }, {})
    );
  }

  async _write(input: unknown, config: RunnableConfig): Promise<void> {
    const values = await this._getWriteValues(input, config);
    ChannelWrite.doWrite(config, values);
  }

  static doWrite(
    config: RunnableConfig,
    values: Record<string, unknown>
  ): void {
    const write: TYPE_SEND = config.configurable?.[CONFIG_KEY_SEND];
    write(
      Object.entries(values).filter(([_channel, value]) => value !== SKIP_WRITE)
    );
  }

  static isWriter(runnable: RunnableLike): boolean {
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

import {
  Runnable,
  RunnableConfig,
  RunnableLike,
} from "@langchain/core/runnables";
import { ConfigurableFieldSpec } from "../checkpoint/index.js";
import { CONFIG_KEY_SEND } from "../constants.js";
import { RunnableCallable } from "../utils.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TYPE_SEND = (values: Array<[string, any]>) => void;

export const SKIP_WRITE = {};
export const PASSTHROUGH = {};

/**
 * Mapping of write channels to Runnables that return the value to be written,
 * or None to skip writing.
 */
export class ChannelWrite<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  RunInput = any
> extends RunnableCallable {
  writes: Array<ChannelWriteEntry>;

  constructor(writes: Array<ChannelWriteEntry>) {
    const name = `ChannelWrite<${writes
      .map(({ channel }) => channel)
      .join(",")}>`;
    super({
      ...{ writes, name },
      func: async (input: RunInput, config?: RunnableConfig) =>
        this._write(input, config ?? {}),
    });

    this.writes = writes;
  }

  get configSpecs(): ConfigurableFieldSpec[] {
    return [
      {
        id: CONFIG_KEY_SEND,
        name: CONFIG_KEY_SEND,
        description: null,
        default: null,
        annotation: "TYPE_SEND",
        isShared: false,
        dependencies: null,
      },
    ];
  }

  async _getWriteValues(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    input: any,
    config: RunnableConfig
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<Record<string, any>> {
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .reduce((acc: Record<string, any>, write: ChannelWriteEntry) => {
          acc[write.channel] = write.value;
          return acc;
        }, {})
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async _write(input: any, config: RunnableConfig): Promise<void> {
    const values = await this._getWriteValues(input, config);
    ChannelWrite.doWrite(config, values);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  static doWrite(config: RunnableConfig, values: Record<string, any>): void {
    const write: TYPE_SEND = config.configurable?.[CONFIG_KEY_SEND];
    write(
      Object.entries(values).filter(([_channel, value]) => value !== SKIP_WRITE)
    );
  }

  static isWriter(runnable: RunnableLike): boolean {
    // eslint-disable-next-line no-instanceof/no-instanceof
    return runnable instanceof ChannelWrite;
  }

  static registerWriter(runnable: Runnable): ChannelWrite {
    return runnable as ChannelWrite;
  }
}

export interface ChannelWriteEntry {
  channel: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  value: any;
  skipNone: boolean;
  mapper?: Runnable;
}

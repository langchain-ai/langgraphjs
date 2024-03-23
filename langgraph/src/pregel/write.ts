import {
  Runnable,
  RunnableConfig,
  RunnablePassthrough,
} from "@langchain/core/runnables";
import { ConfigurableFieldSpec } from "../checkpoint/index.js";
import { CONFIG_KEY_SEND } from "../constants.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TYPE_SEND = (values: Array<[string, any]>) => void;

export const SKIP_WRITE = {};

/**
 * Mapping of write channels to Runnables that return the value to be written,
 * or None to skip writing.
 */
export class ChannelWrite<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  RunInput = any,
> extends RunnablePassthrough<RunInput> {
  channels: Array<ChannelWriteEntry>;

  constructor(
    channels: Array<ChannelWriteEntry>
  ) {
    const name = `ChannelWrite<${channels.map(({ channel }) => channel).join(",")}>`;
    super({
      ...{ channels, name },
      func: async (input: RunInput, config?: RunnableConfig) =>
        this._write(input, config ?? {}),
    });

    this.channels = channels;
  }

  get configSpecs(): ConfigurableFieldSpec[] {
    return [
      {
        id: CONFIG_KEY_SEND,
        name: CONFIG_KEY_SEND,
        description: null,
        default: null,
        annotation: "TYPE_SEND",
        isShared: true,
        dependencies: null,
      },
    ];
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async coerceValue(input: any, value: any, config: RunnableConfig): Promise<any> {
    if (Runnable.isRunnable(value)) {
      return await value.invoke(input, config)
    } else if (value) {
      return value;
    } return input;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async _write(input: any, config: RunnableConfig): Promise<void> {
    const values = this.channels.map(async ({ channel, value, skipNone }) => ({
      channel,
      value: await this.coerceValue(input, value, config),
      skipNone,
    }));

    const valuesAwaited = await Promise.all(values);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const newValues: Record<string, any> = {};
    for (const { channel, value, skipNone } of valuesAwaited) {
      if (!skipNone || value) {
        newValues[channel] = value;
      }
    }

    ChannelWrite.doWrite(
      config,
      newValues
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  static doWrite(config: RunnableConfig, values: Record<string, any>): void {
    const write: TYPE_SEND = config.configurable?.[CONFIG_KEY_SEND];
    const writingThis = Object.entries(values).filter(([_channel, value]) => value !== SKIP_WRITE);
    write(writingThis);
  }
}

export interface ChannelWriteEntry {
  channel: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  value?: any | Runnable;
  skipNone: boolean;
}
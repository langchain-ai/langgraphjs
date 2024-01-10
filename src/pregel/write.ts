import {
  Runnable,
  RunnableConfig,
  RunnablePassthrough
} from "@langchain/core/runnables";
import { ConfigurableFieldSpec } from "../checkpoint/index.js";
import { CONFIG_KEY_SEND } from "../constants.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TYPE_SEND = (values: Array<[string, any]>) => void;

/**
 * Mapping of write channels to Runnables that return the value to be written,
 * or None to skip writing.
 */
export class ChannelWrite<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  RunInput extends Record<string, any> = Record<string, any>
> extends RunnablePassthrough<RunInput> {
  channels: Array<[string, Runnable | undefined]>;

  constructor(channels: Array<[string, Runnable | undefined]>) {
    const name = `ChannelWrite<${channels.map(([chan]) => chan).join(",")}>`;
    super({ func: "_write", afunc: "_awrite", channels, name });
    this.channels = channels;
  }

  __repArgs__() {
    return { channels: this.channels };
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
        dependencies: null
      }
    ];
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _write(input: any, config: RunnableConfig): void {
    const values = this.channels.map(([chan, r]) => [
      chan,
      r ? r.invoke(input, config) : input
    ]);

    ChannelWrite.doWrite(config, Object.fromEntries(values));
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  static doWrite(config: RunnableConfig, values: Record<string, any>): void {
    const write: TYPE_SEND = config.configurable?.[CONFIG_KEY_SEND];
    write(Object.entries(values).filter(([_, val]) => val !== null));
  }
}

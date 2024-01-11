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
  RunInput = any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  RunOutput = any
> extends RunnablePassthrough<RunInput> {
  channels: Array<[string, Runnable<RunInput, RunOutput> | undefined]>;

  constructor(
    channels: Array<[string, Runnable<RunInput, RunOutput> | undefined]>
  ) {
    const name = `ChannelWrite<${channels.map(([chan]) => chan).join(",")}>`;
    super({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      func: (input: any, config: RunnableConfig) => this._write(input, config),
      channels,
      name
    });

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
    console.log("ChannelWrite._write", input, config);
    const values = this.channels.map(([chan, r]) => [
      chan,
      r ? r.invoke(input, config) : input
    ]);

    ChannelWrite.doWrite(config, Object.fromEntries(values));
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  static doWrite(config: RunnableConfig, values: Record<string, any>): void {
    const write: TYPE_SEND = config.configurable?.[CONFIG_KEY_SEND];
    write(Object.entries(values).filter(([_, val]) => Boolean(val)));
  }
}

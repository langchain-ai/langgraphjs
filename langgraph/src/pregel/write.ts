import {
  Runnable,
  RunnableConfig,
  RunnablePassthrough,
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
  async _write(input: any, config: RunnableConfig): Promise<void> {
    const values = this.channels.map(async ([chan, r]) => [
      chan,
      r ? await r.invoke(input, config) : input,
    ]);
    let valuesAwaited = await Promise.all(values);

    valuesAwaited = valuesAwaited.filter((write, index) => 
        this.channels[index][1] === null || write[1] !== null
    );
    ChannelWrite.doWrite(
      config,
      Object.fromEntries(
        valuesAwaited.filter(([_, val], i) =>
          this.channels[i][1] ? Boolean(val) : val
        )
      )
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  static doWrite(config: RunnableConfig, values: Record<string, any>): void {
    const write: TYPE_SEND = config.configurable?.[CONFIG_KEY_SEND];
    write(Object.entries(values));
  }
}

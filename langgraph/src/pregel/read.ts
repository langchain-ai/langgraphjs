import {
  Runnable,
  RunnableBinding,
  RunnableBindingArgs,
  RunnableConfig,
  RunnableEach,
  RunnableLambda,
  RunnableLike,
  RunnablePassthrough,
  _coerceToRunnable,
} from "@langchain/core/runnables";
import { ConfigurableFieldSpec } from "../checkpoint/index.js";
import { CONFIG_KEY_READ } from "../constants.js";

export class ChannelRead<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  RunInput = any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  RunOutput = any
> extends RunnableLambda<RunInput, RunOutput> {
  lc_graph_name = "ChannelRead";

  channel: string;

  constructor(channel: string) {
    super({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      func: (input: RunInput, options?: any) => {
        if ("config" in options) {
          return this._read(input, options.config);
        }
        return this._read(input, options ?? {});
      },
    });
    this.channel = channel;
    this.name = `ChannelRead<${channel}>`;
  }

  get configSpecs(): ConfigurableFieldSpec[] {
    return [
      {
        id: CONFIG_KEY_READ,
        name: CONFIG_KEY_READ,
        description: null,
        default: null,
        // TODO FIX THIS
        annotation: "Callable[[BaseChannel], Any]",
        isShared: true,
        dependencies: null,
      },
    ];
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _read(_: any, config: RunnableConfig) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const read: (arg: string) => any = config.configurable?.[CONFIG_KEY_READ];
    if (!read) {
      throw new Error(
        `Runnable ${this} is not configured with a read function. Make sure to call in the context of a Pregel process`
      );
    }
    return read(this.channel);
  }
}

const defaultRunnableBound = new RunnablePassthrough();

interface ChannelInvokeArgs<RunInput, RunOutput>
  extends Partial<RunnableBindingArgs<RunInput, RunOutput>> {
  channels: Record<string, string> | string;
  triggers: Array<string>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  when?: (args: any) => boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ChannelInvokeInputType = any;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ChannelInvokeOutputType = any;

export class ChannelInvoke<
  RunInput = ChannelInvokeInputType,
  RunOutput = ChannelInvokeOutputType
> extends RunnableBinding<RunInput, RunOutput, RunnableConfig> {
  lc_graph_name = "ChannelInvoke";

  channels: Record<string, string> | string;

  triggers: string[] = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  when?: (args: any) => boolean;

  constructor(fields: ChannelInvokeArgs<RunInput, RunOutput>) {
    const { channels, triggers, when } = fields;
    super({
      ...fields,
      bound:
        fields.bound ??
        (defaultRunnableBound as unknown as Runnable<RunInput, RunOutput>),
      config: fields.config ?? {},
    });

    this.channels = channels;
    this.triggers = triggers;
    this.when = when;
  }

  join(channels: Array<string>): ChannelInvoke<RunInput, RunOutput> {
    if (typeof this.channels !== "object") {
      throw new Error("all channels must be named when using .join()");
    }

    return new ChannelInvoke<RunInput, RunOutput>({
      channels: {
        ...this.channels,
        ...Object.fromEntries(channels.map((chan) => [chan, chan])),
      },
      triggers: this.triggers,
      when: this.when,
      bound: this.bound,
      kwargs: this.kwargs,
      config: this.config,
    });
  }

  pipe<NewRunOutput>(
    coerceable: RunnableLike
  ): ChannelInvoke<RunInput, Exclude<NewRunOutput, Error>> {
    if (this.bound === defaultRunnableBound) {
      return new ChannelInvoke<RunInput, Exclude<NewRunOutput, Error>>({
        channels: this.channels,
        triggers: this.triggers,
        when: this.when,
        bound: _coerceToRunnable<RunInput, NewRunOutput>(coerceable),
        config: this.config,
        kwargs: this.kwargs,
      });
    } else {
      return new ChannelInvoke<RunInput, Exclude<NewRunOutput, Error>>({
        channels: this.channels,
        triggers: this.triggers,
        when: this.when,
        bound: this.bound.pipe(coerceable),
        config: this.config,
        kwargs: this.kwargs,
      });
    }
  }
}

interface ChannelBatchArgs {
  channel: string;
  key?: string;
  bound?: Runnable;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ChannelBatchInputType = any;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ChannelBatchOutputType = any;

export class ChannelBatch extends RunnableEach<
  ChannelBatchInputType,
  ChannelBatchOutputType,
  RunnableConfig
> {
  lc_graph_name = "ChannelBatch";

  channel: string;

  key?: string;

  constructor(fields: ChannelBatchArgs) {
    super({
      ...fields,
      bound: fields.bound ?? defaultRunnableBound,
    });

    this.channel = fields.channel;
    this.key = fields.key;
  }

  join(channels: Array<string>): ChannelBatch {
    if (!this.key) {
      throw new Error(
        `Cannot join() additional channels without a key.\nPass a key arg to Channel.subscribeToEach().`
      );
    }
    const channelsMap: Record<string, ChannelRead> = {};
    for (const chan of channels) {
      channelsMap[chan] = new ChannelRead(chan);
    }
    const joiner = RunnablePassthrough.assign({ ...channelsMap });

    if (this.bound === defaultRunnableBound) {
      return new ChannelBatch({
        channel: this.channel,
        key: this.key,
        bound: joiner,
      });
    } else {
      return new ChannelBatch({
        channel: this.channel,
        key: this.key,
        bound: this.bound.pipe(joiner),
      });
    }
  }

  // @ts-expect-error TODO: fix later
  pipe(coerceable: RunnableLike): ChannelBatch {
    if (this.bound === defaultRunnableBound) {
      return new ChannelBatch({
        channel: this.channel,
        key: this.key,
        bound: _coerceToRunnable(coerceable),
      });
    } else {
      // Delegate to `or` in `this.bound`
      return new ChannelBatch({
        channel: this.channel,
        key: this.key,
        bound: this.bound.pipe(coerceable),
      });
    }
  }
}

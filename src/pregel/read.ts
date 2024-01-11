import {
  Runnable,
  RunnableBinding,
  RunnableConfig,
  RunnableEach,
  RunnableLambda,
  RunnableLike,
  RunnablePassthrough,
  RunnableSequence,
  _coerceToRunnable
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
      }
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
        dependencies: null
      }
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

interface ChannelInvokeArgs<
  RunInput,
  RunOutput,
  CallOptions extends RunnableConfig = RunnableConfig
> {
  channels: Record<string, string>;
  triggers: Array<string>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  when?: (args: any) => boolean;
  bound?: Runnable<RunInput, RunOutput, CallOptions>;
  kwargs?: Partial<CallOptions>;
  config?: RunnableConfig;
}

export class ChannelInvoke<
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    RunInput = any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    RunOutput = any,
    CallOptions extends RunnableConfig = RunnableConfig
  >
  extends RunnableBinding<RunInput, RunOutput, CallOptions>
  implements ChannelInvokeArgs<RunInput, RunOutput, CallOptions>
{
  lc_graph_name = "ChannelInvoke";

  channels: Record<string, string>;

  triggers: string[] = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  when?: (args: any) => boolean;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  kwargs?: Partial<CallOptions> = {};

  constructor(fields: ChannelInvokeArgs<RunInput, RunOutput, CallOptions>) {
    const { channels, triggers, when, kwargs } = fields;
    super({
      ...fields,
      bound:
        fields.bound ??
        (defaultRunnableBound as unknown as Runnable<
          RunInput,
          RunOutput,
          CallOptions
        >),
      config: fields.config ?? {}
    });

    this.channels = channels;
    this.triggers = triggers;
    this.when = when;
    this.kwargs = kwargs;
  }

  join(
    channels: Array<string>
  ): ChannelInvoke<RunInput, RunOutput, CallOptions> {
    if (!Object.keys(this.channels).every((k) => Boolean(k))) {
      throw new Error("all channels must be named when using .join()");
    }
    
    return new ChannelInvoke<RunInput, RunOutput, CallOptions>({
      channels: {
        ...this.channels,
        ...Object.fromEntries(channels.map((chan) => [chan, chan]))
      },
      triggers: this.triggers,
      when: this.when,
      bound: this.bound,
      kwargs: this.kwargs,
      config: this.config
    });
  }

  pipe<NewRunOutput>(
    coerceable: RunnableLike<RunOutput, NewRunOutput>
  ): ChannelInvoke<RunInput, RunOutput, CallOptions>;

  pipe<NewRunOutput>(
    coerceable: RunnableLike<RunOutput, NewRunOutput>
  ): RunnableSequence<RunInput, RunOutput>;

  pipe<NewRunOutput>(
    coerceable: RunnableLike<RunOutput, NewRunOutput>
  ):
    | ChannelInvoke<RunInput, RunOutput, CallOptions>
    | RunnableSequence<RunInput, RunOutput> {
    if (this.bound === defaultRunnableBound) {
      return new ChannelInvoke<RunInput, RunOutput, CallOptions>({
        channels: this.channels,
        triggers: this.triggers,
        when: this.when,
        bound: _coerceToRunnable<RunOutput, NewRunOutput>(coerceable),
        kwargs: this.kwargs,
        config: this.config
      });
    } else {
      return new ChannelInvoke<RunInput, RunOutput, CallOptions>({
        channels: this.channels,
        triggers: this.triggers,
        when: this.when,
        bound: this.bound.pipe<RunOutput>(coerceable),
        kwargs: this.kwargs,
        config: this.config
      });
    }
  }
}

interface ChannelBatchArgs<
  RunInput,
  RunOutput,
  CallOptions extends RunnableConfig = RunnableConfig
> {
  channel: string;
  key?: string;
  bound?: Runnable<RunInput, RunOutput, CallOptions>;
}

export class ChannelBatch<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  RunInput = any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  RunOutput = any,
  CallOptions extends RunnableConfig = RunnableConfig
> extends RunnableEach<RunInput, RunOutput, CallOptions> {
  lc_graph_name = "ChannelBatch";

  channel: string;

  key?: string;

  constructor(fields: ChannelBatchArgs<RunInput, RunOutput, CallOptions>) {
    super({
      ...fields,
      bound:
        fields.bound ??
        (defaultRunnableBound as unknown as Runnable<
          RunInput,
          RunOutput,
          CallOptions
        >)
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
    const channelsMap: Record<string, ChannelRead<RunInput, RunOutput>> = {};
    for (const chan of channels) {
      channelsMap[chan] = new ChannelRead<RunInput, RunOutput>(chan);
    }
    const joiner = RunnablePassthrough.assign({
      ...channelsMap
    });

    if (this.bound === defaultRunnableBound) {
      return new ChannelBatch({
        channel: this.channel,
        key: this.key,
        bound: joiner
      });
    } else {
      return new ChannelBatch({
        channel: this.channel,
        key: this.key,
        bound: this.bound.pipe<RunOutput>(joiner)
      });
    }
  }

  pipe<NewRunOutput>(
    coerceable: RunnableLike<RunOutput[], NewRunOutput>
  ): ChannelBatch<RunInput, RunOutput, CallOptions>;

  pipe<NewRunOutput>(
    coerceable: RunnableLike<RunOutput[], NewRunOutput>
  ): RunnableSequence<RunInput[], RunOutput>;

  pipe<NewRunOutput>(
    coerceable: RunnableLike<RunOutput[], NewRunOutput>
  ):
    | ChannelBatch<RunInput, RunOutput, CallOptions>
    | RunnableSequence<RunInput[], RunOutput> {
    if (this.bound === defaultRunnableBound) {
      return new ChannelBatch<RunInput, RunOutput, CallOptions>({
        channel: this.channel,
        key: this.key,
        bound: _coerceToRunnable<RunOutput, NewRunOutput>(coerceable)
      });
    } else {
      // Delegate to `or` in `this.bound`
      return new ChannelBatch<RunInput, RunOutput, CallOptions>({
        channel: this.channel,
        key: this.key,
        bound: this.pipe<RunOutput>(this.bound ?? coerceable)
      });
    }
  }
}

import {
  Runnable,
  RunnableBinding,
  RunnableBindingArgs,
  RunnableConfig,
  RunnableEach,
  RunnableLambda,
  RunnablePassthrough,
  _coerceToRunnable,
} from "@langchain/core/runnables";
import { ConfigurableFieldSpec } from "../checkpoint/index.js";
import { CONFIG_KEY_READ } from "../constants.js";

export class ChannelRead<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  RunInput extends Record<string, any> = Record<string, any>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  RunOutput extends Record<string, any> = Record<string, any>
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

function _createDefaultBound<RunInput>() {
  return new RunnablePassthrough<RunInput>();
}

interface ChannelInvokeArgs<
  RunInput,
  RunOutput,
  CallOptions extends RunnableConfig
> {
  channels: Record<string, string>;
  triggers: Array<string>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  when?: (args: any) => boolean;
  bound?: RunnableBindingArgs<RunInput, RunOutput, CallOptions>["bound"];
  kwargs?: RunnableBindingArgs<RunInput, RunOutput, CallOptions>["kwargs"];
  config?: RunnableBindingArgs<RunInput, RunOutput, CallOptions>["config"];
}

export class ChannelInvoke<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  RunInput extends Record<string, any> = Record<string, any>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  RunOutput extends Record<string, any> = Record<string, any>,
  CallOptions extends RunnableConfig = RunnableConfig
> extends RunnableBinding<RunInput, RunOutput, CallOptions> {
  lc_graph_name = "ChannelInvoke";

  channels: Record<string, string>;

  triggers: string[] = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  when?: (args: any) => boolean;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  kwargs?: Partial<CallOptions> = {};

  constructor(fields: ChannelInvokeArgs<RunInput, RunOutput, CallOptions>) {
    const { channels, triggers, when, kwargs } = fields;
    // @TODO can we get rid of this?
    const defaultBound = _createDefaultBound<RunInput>() as unknown as Runnable<
      RunInput,
      RunOutput,
      CallOptions
    >;

    super({
      bound: fields.bound ?? defaultBound,
      config: fields.config ?? {},
    });

    this.channels = channels;
    this.triggers = triggers;
    this.when = when;
    this.kwargs = kwargs;
  }

  join(channels: Array<string>): ChannelInvoke {
    if (!Object.keys(this.channels).every((k) => k !== null)) {
      throw new Error("all channels must be named when using .join()");
    }
    return new ChannelInvoke({
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

  // @TODO verify w/ nuno this implementation of `other` as `any` is correct.
  combineWith(
    other: // eslint-disable-next-line @typescript-eslint/no-explicit-any
    | Runnable<any, any>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      | ((args: any) => any)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      | Record<string, Runnable<any, any> | ((args: any) => any)>
  ): ChannelInvoke {
    // @TODO can we get rid of this?
    const defaultBound = _createDefaultBound<RunInput>() as unknown as Runnable<
      RunInput,
      RunOutput,
      CallOptions
    >;

    if (this.bound === defaultBound) {
      return new ChannelInvoke({
        channels: this.channels,
        triggers: this.triggers,
        when: this.when,
        bound: _coerceToRunnable(other),
        kwargs: this.kwargs,
        config: this.config,
      });
    } else {
      return new ChannelInvoke({
        channels: this.channels,
        triggers: this.triggers,
        when: this.when,
        bound: this.combineWith(this.bound ?? other),
        kwargs: this.kwargs,
        config: this.config,
      });
    }
  }
}

interface ChannelBatchArgs<
  RunInput,
  RunOutput,
  CallOptions extends RunnableConfig
> {
  channel: string;
  key?: string;
  bound?: RunnableBindingArgs<RunInput, RunOutput, CallOptions>["bound"];
}

export class ChannelBatch<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  RunInput extends Record<string, any> = Record<string, any>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  RunOutput extends Record<string, any> = Record<string, any>,
  CallOptions extends RunnableConfig = RunnableConfig
> extends RunnableEach<RunInput, RunOutput, CallOptions> {
  lc_graph_name = "ChannelBatch";

  channel: string;

  key?: string;

  constructor(fields: ChannelBatchArgs<RunInput, RunOutput, CallOptions>) {
    // @TODO can we get rid of this?
    const defaultBound = _createDefaultBound<RunInput>() as unknown as Runnable<
      RunInput,
      RunOutput,
      CallOptions
    >;

    super({
      bound: fields.bound ?? defaultBound,
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
    const joiner = RunnablePassthrough.assign({
      ...channelsMap,
    });

    // @TODO can we get rid of this?
    const defaultBound = _createDefaultBound<RunInput>() as unknown as Runnable<
      RunInput,
      RunOutput,
      CallOptions
    >;
    if (this.bound === defaultBound) {
      return new ChannelBatch({
        channel: this.channel,
        key: this.key,
        bound: joiner,
      });
    } else {
      return new ChannelBatch({
        channel: this.channel,
        key: this.key,
        bound: this.combineWith(this.bound ?? joiner),
      });
    }
  }

  // @TODO verify w/ nuno this implementation of `other` as `any` is correct.
  combineWith(
    other: // eslint-disable-next-line @typescript-eslint/no-explicit-any
    | Runnable<any, any>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      | ((args: any) => any)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      | Record<string, Runnable<any, any> | ((args: any) => any)>
  ): ChannelBatch {
    // @TODO can we get rid of this?
    const defaultBound = _createDefaultBound<RunInput>() as unknown as Runnable<
      RunInput,
      RunOutput,
      CallOptions
    >;

    if (this.bound === defaultBound) {
      return new ChannelBatch({
        channel: this.channel,
        key: this.key,
        bound: _coerceToRunnable(other),
      });
    } else {
      // Delegate to `or` in `this.bound`
      return new ChannelBatch({
        channel: this.channel,
        key: this.key,
        bound: this.combineWith(this.bound ?? other),
      });
    }
  }
}

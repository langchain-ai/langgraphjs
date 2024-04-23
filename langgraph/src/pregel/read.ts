import {
  Runnable,
  RunnableBinding,
  RunnableBindingArgs,
  RunnableConfig,
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

  channel: string | Array<string>;

  constructor(channel: string | Array<string>) {
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
    if (Array.isArray(this.channel)) {
      const results = Object.fromEntries(
        this.channel.map((chan) => [chan, read(chan)])
      );
      return results;
    }
    return read(this.channel);
  }
}

const defaultRunnableBound = /* #__PURE__ */ new RunnablePassthrough();

interface PregelNodeArgs<RunInput, RunOutput>
  extends Partial<RunnableBindingArgs<RunInput, RunOutput>> {
  channels: Record<string, string> | string[];
  triggers: Array<string>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mapper?: (args: any) => any;
  writers?: Runnable[];
  tags?: string[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  bound?: Runnable<any, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  kwargs?: Record<string, any>;
  config?: RunnableConfig;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PregelNodeInputType = any;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PregelNodeOutputType = any;

export class PregelNode<
  RunInput = PregelNodeInputType,
  RunOutput = PregelNodeOutputType
> extends RunnableBinding<RunInput, RunOutput, RunnableConfig> {
  lc_graph_name = "PregelNode";

  channels: Record<string, string> | string[];

  triggers: string[] = [];

  mapper?: (args: any) => any;

  writers: Runnable[] = [];

  bound: Runnable<any, any> = defaultRunnableBound;

  kwargs: Record<string, any> = {};

  constructor(fields: PregelNodeArgs<RunInput, RunOutput>) {
    const { channels, triggers, mapper, writers, bound, kwargs } = fields;
    const mergedTags = [
      ...(fields.config?.tags ? fields.config.tags : []),
      ...(fields.tags ? fields.tags : []),
    ];

    super({
      ...fields,
      bound:
        fields.bound ??
        (defaultRunnableBound as unknown as Runnable<RunInput, RunOutput>),
      config: {
        ...(fields.config ? fields.config : {}),
        tags: mergedTags,
      },
    });

    this.channels = channels;
    this.triggers = triggers;
    this.mapper = mapper;
    this.writers = writers ?? this.writers;
    this.bound = bound ?? this.bound;
    this.kwargs = kwargs ?? this.kwargs;
  }

  join(channels: Array<string>): PregelNode<RunInput, RunOutput> {
    if (typeof this.channels !== "object") {
      throw new Error("all channels must be named when using .join()");
    }

    return new PregelNode<RunInput, RunOutput>({
      channels: {
        ...this.channels,
        ...Object.fromEntries(channels.map((chan) => [chan, chan])),
      },
      triggers: this.triggers,
      bound: this.bound,
      kwargs: this.kwargs,
      config: this.config,
    });
  }

  pipe<NewRunOutput>(
    coerceable: RunnableLike
  ): PregelNode<RunInput, Exclude<NewRunOutput, Error>> {
    if (this.bound === defaultRunnableBound) {
      return new PregelNode<RunInput, Exclude<NewRunOutput, Error>>({
        channels: this.channels,
        triggers: this.triggers,
        bound: _coerceToRunnable<RunInput, NewRunOutput>(coerceable),
        config: this.config,
        kwargs: this.kwargs,
      });
    } else {
      return new PregelNode<RunInput, Exclude<NewRunOutput, Error>>({
        channels: this.channels,
        triggers: this.triggers,
        bound: this.bound.pipe(coerceable),
        config: this.config,
        kwargs: this.kwargs,
      });
    }
  }
}

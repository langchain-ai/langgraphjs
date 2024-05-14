import {
  Runnable,
  RunnableBinding,
  RunnableBindingArgs,
  RunnableConfig,
  RunnableLike,
  RunnablePassthrough,
  RunnableSequence,
  _coerceToRunnable,
} from "@langchain/core/runnables";
import { ConfigurableFieldSpec } from "../checkpoint/index.js";
import { CONFIG_KEY_READ } from "../constants.js";
import { ChannelWrite } from "./write.js";
import { RunnableCallable } from "../utils.js";

export class ChannelRead<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  RunInput = any
> extends RunnableCallable {
  lc_graph_name = "ChannelRead";

  channel: string | Array<string>;

  fresh: boolean = false;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mapper?: (args: any) => any;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(
    channel: string | Array<string>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mapper?: (args: any) => any,
    fresh: boolean = false
  ) {
    super({
      func: (_: RunInput, config: RunnableConfig) =>
        ChannelRead.doRead(config, this.channel, this.fresh, this.mapper),
    });
    this.fresh = fresh;
    this.mapper = mapper;
    this.channel = channel;
    this.name = Array.isArray(channel)
      ? `ChannelRead<${channel.join(",")}>`
      : `ChannelRead<${channel}>`;
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
        isShared: false,
        dependencies: null,
      },
    ];
  }

  static doRead<T = unknown>(
    config: RunnableConfig,
    channel: string | Array<string>,
    fresh: boolean,
    mapper?: (args: unknown) => unknown
  ): T {
    const read: (arg: string | string[], fresh: boolean) => unknown =
      config.configurable?.[CONFIG_KEY_READ];
    if (!read) {
      throw new Error(
        `Runnable ${this} is not configured with a read function. Make sure to call in the context of a Pregel process`
      );
    }
    if (mapper) {
      return mapper(read(channel, fresh)) as T;
    } else {
      return read(channel, fresh) as T;
    }
  }
}

const defaultRunnableBound =
  /* #__PURE__ */ new RunnablePassthrough<PregelNodeInputType>();

interface PregelNodeArgs<RunInput, RunOutput>
  extends Partial<RunnableBindingArgs<RunInput, RunOutput>> {
  channels: Record<string, string> | string[];
  triggers: Array<string>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mapper?: (args: any) => any;
  writers?: Runnable<RunOutput, unknown>[];
  tags?: string[];
  bound?: Runnable<RunInput, RunOutput>;
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mapper?: (args: any) => any;

  writers: Runnable[] = [];

  bound: Runnable<RunInput, RunOutput> = defaultRunnableBound;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

  getWriters(): Array<Runnable> {
    const newWriters = [...this.writers];
    while (
      newWriters.length > 1 &&
      // eslint-disable-next-line no-instanceof/no-instanceof
      newWriters[newWriters.length - 1] instanceof ChannelWrite &&
      // eslint-disable-next-line no-instanceof/no-instanceof
      newWriters[newWriters.length - 2] instanceof ChannelWrite
    ) {
      // we can combine writes if they are consecutive
      (newWriters[newWriters.length - 2] as ChannelWrite).writes.push(
        ...(newWriters[newWriters.length - 1] as ChannelWrite).writes
      );
      newWriters.pop();
    }
    return newWriters;
  }

  getNode(): Runnable<RunInput, RunOutput> | undefined {
    const writers = this.getWriters();
    if (this.bound === defaultRunnableBound && writers.length === 0) {
      return undefined;
    } else if (this.bound === defaultRunnableBound && writers.length === 1) {
      return writers[0];
    } else if (this.bound === defaultRunnableBound) {
      return new RunnableSequence({
        first: writers[0],
        middle: writers.slice(1, writers.length - 1),
        last: writers[writers.length - 1],
      });
    } else if (writers.length > 0) {
      return new RunnableSequence({
        first: this.bound,
        middle: writers.slice(0, writers.length - 1),
        last: writers[writers.length - 1],
      });
    } else {
      return this.bound;
    }
  }

  join(channels: Array<string>): PregelNode<RunInput, RunOutput> {
    if (!Array.isArray(channels)) {
      throw new Error("channels must be a list");
    }
    if (typeof this.channels !== "object") {
      throw new Error("all channels must be named when using .join()");
    }

    return new PregelNode<RunInput, RunOutput>({
      channels: {
        ...this.channels,
        ...Object.fromEntries(channels.map((chan) => [chan, chan])),
      },
      triggers: this.triggers,
      mapper: this.mapper,
      writers: this.writers,
      bound: this.bound,
      kwargs: this.kwargs,
      config: this.config,
    });
  }

  pipe<NewRunOutput>(
    coerceable: RunnableLike
  ): PregelNode<RunInput, Exclude<NewRunOutput, Error>> {
    if (ChannelWrite.isWriter(coerceable)) {
      return new PregelNode<RunInput, Exclude<NewRunOutput, Error>>({
        channels: this.channels,
        triggers: this.triggers,
        mapper: this.mapper,
        writers: [...this.writers, coerceable as ChannelWrite],
        bound: this.bound as unknown as PregelNode<
          RunInput,
          Exclude<NewRunOutput, Error>
        >,
        config: this.config,
        kwargs: this.kwargs,
      });
    } else if (this.bound === defaultRunnableBound) {
      return new PregelNode<RunInput, Exclude<NewRunOutput, Error>>({
        channels: this.channels,
        triggers: this.triggers,
        mapper: this.mapper,
        writers: this.writers,
        bound: _coerceToRunnable<RunInput, NewRunOutput>(coerceable),
        config: this.config,
        kwargs: this.kwargs,
      });
    } else {
      return new PregelNode<RunInput, Exclude<NewRunOutput, Error>>({
        channels: this.channels,
        triggers: this.triggers,
        mapper: this.mapper,
        writers: this.writers,
        bound: this.bound.pipe(coerceable),
        config: this.config,
        kwargs: this.kwargs,
      });
    }
  }
}

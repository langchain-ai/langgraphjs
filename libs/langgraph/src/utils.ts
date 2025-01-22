import { CallbackManagerForChainRun } from "@langchain/core/callbacks/manager";
import {
  mergeConfigs,
  patchConfig,
  Runnable,
  RunnableConfig,
} from "@langchain/core/runnables";
import { AsyncLocalStorageProviderSingleton } from "@langchain/core/singletons";
import { IterableReadableStream } from "@langchain/core/utils/stream";
import { ensureLangGraphConfig } from "./pregel/utils/config.js";
import { StreamMode } from "./pregel/types.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface RunnableCallableArgs extends Partial<any> {
  name?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  func: (...args: any[]) => any;
  tags?: string[];
  trace?: boolean;
  recurse?: boolean;
}

export class RunnableCallable<I = unknown, O = unknown> extends Runnable<I, O> {
  lc_namespace: string[] = ["langgraph"];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  func: (...args: any[]) => any;

  tags?: string[];

  config?: RunnableConfig;

  trace: boolean = true;

  recurse: boolean = true;

  constructor(fields: RunnableCallableArgs) {
    super();
    this.name = fields.name ?? fields.func.name;
    this.func = fields.func;
    this.config = fields.tags ? { tags: fields.tags } : undefined;
    this.trace = fields.trace ?? this.trace;
    this.recurse = fields.recurse ?? this.recurse;
  }

  protected async _tracedInvoke(
    input: I,
    config?: Partial<RunnableConfig>,
    runManager?: CallbackManagerForChainRun
  ) {
    return new Promise<O>((resolve, reject) => {
      const childConfig = patchConfig(config, {
        callbacks: runManager?.getChild(),
      });
      void AsyncLocalStorageProviderSingleton.runWithConfig(
        childConfig,
        async () => {
          try {
            const output = await this.func(input, childConfig);
            resolve(output);
          } catch (e) {
            reject(e);
          }
        }
      );
    });
  }

  async invoke(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    input: I,
    options?: Partial<RunnableConfig> | undefined
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<O> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let returnValue: any;
    const config = ensureLangGraphConfig(options);
    const mergedConfig = mergeConfigs(this.config, config);

    if (this.trace) {
      returnValue = await this._callWithConfig(
        this._tracedInvoke,
        input,
        mergedConfig
      );
    } else {
      returnValue = await AsyncLocalStorageProviderSingleton.runWithConfig(
        mergedConfig,
        async () => this.func(input, mergedConfig)
      );
    }

    if (Runnable.isRunnable(returnValue) && this.recurse) {
      return await AsyncLocalStorageProviderSingleton.runWithConfig(
        mergedConfig,
        async () => returnValue.invoke(input, mergedConfig)
      );
    }

    return returnValue;
  }
}

export function prefixGenerator<T, Prefix extends string>(
  generator: Generator<T>,
  prefix: Prefix
): Generator<[Prefix, T]>;
export function prefixGenerator<T>(
  generator: Generator<T>,
  prefix?: undefined
): Generator<T>;
export function prefixGenerator<
  T,
  Prefix extends string | undefined = undefined
>(
  generator: Generator<T>,
  prefix?: Prefix | undefined
): Generator<Prefix extends string ? [Prefix, T] : T>;
export function* prefixGenerator<
  T,
  Prefix extends string | undefined = undefined
>(
  generator: Generator<T>,
  prefix?: Prefix | undefined
): Generator<Prefix extends string ? [Prefix, T] : T> {
  if (prefix === undefined) {
    yield* generator as Generator<Prefix extends string ? [Prefix, T] : T>;
  } else {
    for (const value of generator) {
      yield [prefix, value] as Prefix extends string ? [Prefix, T] : T;
    }
  }
}

// https://github.com/tc39/proposal-array-from-async
export async function gatherIterator<T>(
  i:
    | AsyncIterable<T>
    | Promise<AsyncIterable<T>>
    | Iterable<T>
    | Promise<Iterable<T>>
): Promise<Array<T>> {
  const out: T[] = [];
  for await (const item of await i) {
    out.push(item);
  }
  return out;
}

export function gatherIteratorSync<T>(i: Iterable<T>): Array<T> {
  const out: T[] = [];
  for (const item of i) {
    out.push(item);
  }
  return out;
}

export function patchConfigurable(
  config: RunnableConfig | undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  patch: Record<string, any>
): RunnableConfig {
  if (!config) {
    return {
      configurable: patch,
    };
  } else if (!("configurable" in config)) {
    return {
      ...config,
      configurable: patch,
    };
  } else {
    return {
      ...config,
      configurable: {
        ...config.configurable,
        ...patch,
      },
    };
  }
}

// [namespace, streamMode, payload]
export type StreamChunk = [string[], StreamMode, unknown];

export class IterableReadableWritableStream extends IterableReadableStream<StreamChunk> {
  modes: Set<StreamMode>;

  private controller: ReadableStreamDefaultController;

  private passthroughFn?: (chunk: StreamChunk) => void;

  private _closed: boolean = false;

  get closed() {
    return this._closed;
  }

  constructor(params: {
    passthroughFn?: (chunk: StreamChunk) => void;
    modes: Set<StreamMode>;
  }) {
    let streamControllerPromiseResolver: (
      controller: ReadableStreamDefaultController
    ) => void;
    const streamControllerPromise: Promise<ReadableStreamDefaultController> =
      new Promise<ReadableStreamDefaultController>((resolve) => {
        streamControllerPromiseResolver = resolve;
      });

    super({
      start: (controller) => {
        streamControllerPromiseResolver!(controller);
      },
    });

    // .start() will always be called before the stream can be interacted
    // with anyway
    void streamControllerPromise.then((controller) => {
      this.controller = controller;
    });

    this.passthroughFn = params.passthroughFn;
    this.modes = params.modes;
  }

  push(chunk: StreamChunk) {
    this.passthroughFn?.(chunk);
    this.controller.enqueue(chunk);
  }

  close() {
    try {
      this.controller.close();
    } catch (e) {
      // pass
    } finally {
      this._closed = true;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  error(e: any) {
    this.controller.error(e);
  }
}

export class StreamFlusher {
  private _nextChunk: Promise<IteratorResult<StreamChunk>> | undefined;

  private readonly _stream: IterableReadableWritableStream;

  private readonly _streamMode: StreamMode[];

  private readonly _streamSubgraphs?: boolean;

  private readonly _streamModeSingle?: boolean;

  terminated: boolean = false;

  private readonly _timeoutSymbol: symbol = Symbol.for("timeout");

  constructor({
    stream,
    streamMode,
    streamModeSingle,
    streamSubgraphs,
  }: {
    stream: IterableReadableWritableStream;
    streamMode: StreamMode[];
    streamSubgraphs?: boolean;
    streamModeSingle?: boolean;
  }) {
    this._stream = stream;
    this._streamMode = streamMode;
    this._streamModeSingle = streamModeSingle;
    this._streamSubgraphs = streamSubgraphs;
  }

  async *flushAll() {
    yield* this.flush({ blockUntilFinished: true });
  }

  async *flush(options?: { blockUntilFinished: boolean }) {
    const { blockUntilFinished = false } = options ?? {};

    if (this.terminated) {
      return;
    }

    while (!this.terminated) {
      if (!this._nextChunk) {
        this._nextChunk = this._stream.next();
      }

      const chunk = blockUntilFinished
        ? await this._nextChunk
        : await Promise.race([this._nextChunk, this._timeout()]);
      if (chunk === this._timeoutSymbol) {
        break;
      } else {
        this._nextChunk = undefined;
      }

      const chunkResult = chunk as IteratorResult<StreamChunk>;

      if (chunkResult.done) {
        this.terminated = true;
        return chunkResult.value;
      } else {
        if (chunkResult.value === undefined) {
          throw new Error("Data structure error.");
        }
        const [namespace, mode, payload] = chunkResult.value;
        if (this._streamMode.includes(mode)) {
          if (this._streamSubgraphs && !this._streamModeSingle) {
            yield [namespace, mode, payload];
          } else if (!this._streamModeSingle) {
            yield [mode, payload];
          } else if (this._streamSubgraphs) {
            yield [namespace, payload];
          } else {
            yield payload;
          }
        }
      }
    }
  }

  private _timeout() {
    return new Promise((resolve) => {
      process.nextTick(() => resolve(this._timeoutSymbol));
    }) as Promise<typeof this._timeoutSymbol>;
  }
}

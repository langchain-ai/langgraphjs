import { CallbackManagerForChainRun } from "@langchain/core/callbacks/manager";
import {
  mergeConfigs,
  patchConfig,
  Runnable,
  RunnableConfig,
} from "@langchain/core/runnables";
import { AsyncLocalStorageProviderSingleton } from "@langchain/core/singletons";
import { ensureLangGraphConfig } from "./pregel/utils/config.js";

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
    // Skip mergeConfigs when this.config is undefined (common case for
    // RunnableCallable instances without tags) to avoid creating a new object
    const mergedConfig = this.config
      ? mergeConfigs(this.config, config)
      : config;

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

export function isAsyncGeneratorFunction(
  val: unknown
): val is AsyncGeneratorFunction {
  return (
    val != null &&
    typeof val === "function" &&
    // eslint-disable-next-line no-instanceof/no-instanceof
    val instanceof Object.getPrototypeOf(async function* () {}).constructor
  );
}

export function isGeneratorFunction(val: unknown): val is GeneratorFunction {
  return (
    val != null &&
    typeof val === "function" &&
    // eslint-disable-next-line no-instanceof/no-instanceof
    val instanceof Object.getPrototypeOf(function* () {}).constructor
  );
}

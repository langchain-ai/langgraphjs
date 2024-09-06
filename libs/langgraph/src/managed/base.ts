import { RunnableConfig } from "@langchain/core/runnables";
import { RUNTIME_PLACEHOLDER } from "../constants.js";

export interface ManagedValueParams extends Record<string, any> {}

export abstract class ManagedValue<Value = any> {
  runtime: boolean = false;

  config: RunnableConfig;

  private _promises: Promise<unknown>[] = [];

  constructor(config: RunnableConfig, _params?: ManagedValueParams) {
    this.config = config;
  }

  static async initialize<Value>(
    this: new (
      config: RunnableConfig,
      params?: ManagedValueParams
    ) => ManagedValue<Value>,
    config: RunnableConfig,
    ...args: any[]
  ): Promise<ManagedValue<Value>> {
    return new this(config, {
      ...args,
    });
  }

  tick(): Promise<boolean> {
    // By default, return false.
    return Promise.resolve(false);
  }

  abstract call(step: number): Value;

  async promises(): Promise<unknown> {
    return Promise.all(this._promises);
  }

  protected addPromise(promise: Promise<unknown>): void {
    this._promises.push(promise);
  }
}

export abstract class WritableManagedValue<
  Value,
  Update
> extends ManagedValue<Value> {
  abstract update(writes: Update[]): Promise<void>;
}

export interface ConfiguredManagedValue<Value> {
  cls: typeof ManagedValue<Value>;
  params: Record<string, any>;
}

export class ManagedValueMapping {
  private mapping: Record<string, ManagedValue<any>> = {};

  replaceRuntimeValues(step: number, values: Record<string, any> | any): void {
    if (Object.keys(this.mapping).length === 0 || !values) return;
    if (Object.values(this.mapping).every((mv) => !mv.runtime)) return;

    if (
      typeof values === "object" &&
      values !== null &&
      "constructor" in values
    ) {
      for (const key of Object.getOwnPropertyNames(
        Object.getPrototypeOf(values)
      )) {
        try {
          const value = values[key];
          for (const [chan, mv] of Object.entries(this.mapping)) {
            if (mv.runtime && mv.call(step) === value) {
              values[key] = { [RUNTIME_PLACEHOLDER]: chan };
            }
          }
        } catch (error) {
          if (!(error instanceof TypeError)) throw error;
        }
      }
    } else if (typeof values === "object" && values !== null) {
      if (Array.isArray(values)) return;

      for (const [key, value] of Object.entries(values)) {
        for (const [chan, mv] of Object.entries(this.mapping)) {
          if (mv.runtime && mv.call(step) === value) {
            values[key] = { [RUNTIME_PLACEHOLDER]: chan };
          }
        }
      }
    }
  }

  replaceRuntimePlaceholders(
    step: number,
    values: Record<string, any> | any
  ): void {
    if (Object.keys(this.mapping).length === 0 || !values) return;
    if (Object.values(this.mapping).every((mv) => !mv.runtime)) return;

    if (
      typeof values === "object" &&
      values !== null &&
      "constructor" in values
    ) {
      for (const key of Object.getOwnPropertyNames(
        Object.getPrototypeOf(values)
      )) {
        try {
          const value = values[key];
          if (
            typeof value === "object" &&
            value !== null &&
            RUNTIME_PLACEHOLDER in value
          ) {
            const chan = value[RUNTIME_PLACEHOLDER] as string;
            values[key] = this.mapping[chan]?.call(step);
          }
        } catch (error) {
          if (!(error instanceof TypeError)) throw error;
        }
      }
    } else if (typeof values === "object" && values !== null) {
      if (Array.isArray(values)) return;

      for (const [key, value] of Object.entries(values)) {
        if (
          typeof value === "object" &&
          value !== null &&
          RUNTIME_PLACEHOLDER in value
        ) {
          const chan = value[RUNTIME_PLACEHOLDER] as string;
          values[key] = this.mapping[chan]?.call(step);
        }
      }
    }
  }
}

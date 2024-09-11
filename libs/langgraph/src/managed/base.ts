import { RunnableConfig } from "@langchain/core/runnables";
import { RUNTIME_PLACEHOLDER } from "../constants.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface ManagedValueParams extends Record<string, any> {}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Value = any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Update = any
> extends ManagedValue<Value> {
  abstract update(writes: Update[]): Promise<void>;
}

export type ManagedValueSpec = typeof ManagedValue | ConfiguredManagedValue;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface ConfiguredManagedValue<Value = any> {
  cls: typeof ManagedValue<Value>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params: Record<string, any>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export class ManagedValueMapping extends Map<string, ManagedValue<any>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  replaceRuntimeValues(step: number, values: Record<string, any> | any): void {
    if (this.size === 0 || !values) {
      return;
    }

    if (Array.from(this.values()).every((mv) => !mv.runtime)) {
      return;
    }

    if (typeof values === "object" && !Array.isArray(values)) {
      for (const [key, value] of Object.entries(values)) {
        for (const [chan, mv] of this.entries()) {
          if (mv.runtime && mv.call(step) === value) {
            // eslint-disable-next-line no-param-reassign
            values[key] = { [RUNTIME_PLACEHOLDER]: chan };
          }
        }
      }
    } else if (typeof values === "object" && "constructor" in values) {
      for (const key of Object.getOwnPropertyNames(
        Object.getPrototypeOf(values)
      )) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const value = (values as any)[key];
          for (const [chan, mv] of this.entries()) {
            if (mv.runtime && mv.call(step) === value) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any, no-param-reassign
              (values as any)[key] = { [RUNTIME_PLACEHOLDER]: chan };
            }
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (error: any) {
          // Ignore if TypeError
          if (error.name !== TypeError.name) {
            throw error;
          }
        }
      }
    }
  }

  replaceRuntimePlaceholders(
    step: number,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    values: Record<string, any> | any
  ): void {
    if (this.size === 0 || !values) {
      return;
    }

    if (Array.from(this.values()).every((mv) => !mv.runtime)) {
      return;
    }

    if (typeof values === "object" && !Array.isArray(values)) {
      for (const [key, value] of Object.entries(values)) {
        if (
          typeof value === "object" &&
          value !== null &&
          RUNTIME_PLACEHOLDER in value
        ) {
          const placeholder = value[RUNTIME_PLACEHOLDER];
          if (typeof placeholder === "string") {
            // eslint-disable-next-line no-param-reassign
            values[key] = this.get(placeholder)?.call(step);
          }
        }
      }
    } else if (typeof values === "object" && "constructor" in values) {
      for (const key of Object.getOwnPropertyNames(
        Object.getPrototypeOf(values)
      )) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const value = (values as any)[key];
          if (
            typeof value === "object" &&
            value !== null &&
            RUNTIME_PLACEHOLDER in value
          ) {
            const managedValue = this.get(value[RUNTIME_PLACEHOLDER]);
            if (managedValue) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any, no-param-reassign
              (values as any)[key] = managedValue.call(step);
            }
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (error: any) {
          // Ignore if TypeError
          if (error.name !== TypeError.name) {
            throw error;
          }
        }
      }
    }
  }
}

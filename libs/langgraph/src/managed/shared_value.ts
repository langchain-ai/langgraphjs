import { RunnableConfig } from "@langchain/core/runnables";
import { BaseStore, type Values } from "../store/base.js";
import {
  ChannelKeyPlaceholder,
  ConfiguredManagedValue,
  ManagedValue,
  ManagedValueParams,
  WritableManagedValue,
} from "./base.js";
import { CONFIG_KEY_STORE } from "../constants.js";
import { InvalidUpdateError } from "../errors.js";

type Value = Record<string, Values>;
type Update = Record<string, Values | null>;

export interface SharedValueParams extends ManagedValueParams {
  scope: string;
  key: string;
}

export class SharedValue extends WritableManagedValue<Value, Update> {
  scope: string;

  store: BaseStore | null;

  ns: string | null;

  value: Value = {};

  constructor(config: RunnableConfig, params: SharedValueParams) {
    super(config, params);
    this.scope = params.scope;
    this.store = config.configurable?.[CONFIG_KEY_STORE] || null;

    if (!this.store) {
      this.ns = null;
    } else if (config.configurable?.[this.scope]) {
      const scopeValue = config.configurable[this.scope];
      const scopedValueString =
        typeof scopeValue === "string"
          ? scopeValue
          : JSON.stringify(scopeValue);
      this.ns = `scoped:${this.scope}:${params.key}:${scopedValueString}`;
    } else {
      throw new Error(
        `Required scope "${this.scope}" for shared state key was not passed in "config.configurable".`
      );
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  static async initialize<Value = any>(
    config: RunnableConfig,
    args: SharedValueParams
  ): Promise<ManagedValue<Value>> {
    const instance = new this(config, args);
    await instance.loadStore();
    return instance as unknown as ManagedValue<Value>;
  }

  static on(scope: string): ConfiguredManagedValue<Value> {
    return {
      cls: SharedValue,
      params: {
        scope,
        key: ChannelKeyPlaceholder,
      },
    };
  }

  call(_step: number): Value {
    return { ...this.value };
  }

  private processUpdate(
    values: Update[]
  ): Array<[string, string, Values | null]> {
    const writes: Array<[string, string, Values | null]> = [];

    for (const vv of values) {
      for (const [k, v] of Object.entries(vv)) {
        if (v === null) {
          if (k in this.value) {
            delete this.value[k];
            if (this.ns) {
              writes.push([this.ns, k, null]);
            }
          }
        } else if (typeof v !== "object" || v === null) {
          throw new InvalidUpdateError("Received a non-object value");
        } else {
          this.value[k] = v as Values;
          if (this.ns) {
            writes.push([this.ns, k, v as Values]);
          }
        }
      }
    }

    return writes;
  }

  async update(values: Update[]): Promise<void> {
    if (!this.store) {
      this.processUpdate(values);
    } else {
      await this.store.put(this.processUpdate(values));
    }
  }

  private async loadStore(): Promise<boolean> {
    if (this.store && this.ns) {
      const saved = await this.store.list([this.ns]);
      this.value = saved[this.ns] || {};
    }
    return false;
  }
}

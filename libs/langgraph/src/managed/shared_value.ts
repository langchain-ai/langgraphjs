import { RunnableConfig } from "@langchain/core/runnables";
import {
  ChannelKeyPlaceholder,
  ConfiguredManagedValue,
  ManagedValue,
  ManagedValueParams,
  WritableManagedValue,
} from "./base.js";
import { CONFIG_KEY_STORE } from "../constants.js";
import { InvalidUpdateError } from "../errors.js";
import { BaseStore, PutOperation } from "@langchain/langgraph-checkpoint";

type Value = Record<string, Record<string, any>>;
type Update = Record<string, Record<string, any> | null>;

export interface SharedValueParams extends ManagedValueParams {
  scope: string;
  key: string;
}

export class SharedValue extends WritableManagedValue<Value, Update> {
  scope: string;

  store: BaseStore | null;

  ns: ["scoped", string, string, any] | null;

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
      this.ns = ["scoped", this.scope, params.key, scopedValueString];
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

  private processUpdate(values: Update[]): Array<PutOperation> {
    const writes: Array<PutOperation> = [];

    for (const vv of values) {
      for (const [k, v] of Object.entries(vv)) {
        if (v === null) {
          if (k in this.value) {
            delete this.value[k];
            if (this.ns) {
              writes.push({ namespace: this.ns, id: k, value: null });
            }
          }
        } else if (typeof v !== "object" || v === null) {
          throw new InvalidUpdateError("Received a non-object value");
        } else {
          this.value[k] = v;
          if (this.ns) {
            writes.push({ namespace: this.ns, id: k, value: v });
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
      await this.store.batch(this.processUpdate(values));
    }
  }

  private async loadStore(): Promise<boolean> {
    if (this.store && this.ns) {
      const saved = await this.store.search(this.ns);
      this.value = saved.reduce((acc, item) => {
        acc[item.id] = item.value;
        return acc;
      }, {} as Record<string, any>);
    }
    return false;
  }
}

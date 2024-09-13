import { type RunnableConfig } from "@langchain/core/runnables";
import {
  ManagedValue,
  type ManagedValueParams,
  type ConfiguredManagedValue,
} from "./base.js";
import { EmptyChannelError } from "../errors.js";

interface ContextParams<Value> extends ManagedValueParams {
  ctx?: () => AsyncGenerator<Value, void, unknown>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export class Context<Value = any> extends ManagedValue<Value> {
  runtime = true;

  value: Value;

  ctx?: () => AsyncGenerator<Value, void, unknown>;

  readonly isContextManagedValue: true = true as const;

  constructor(config: RunnableConfig, params?: ContextParams<Value>) {
    super(config, params);
    this.ctx = params?.ctx;
  }

  private ctxGenerator?: AsyncGenerator<Value, void, unknown>;

  static async initialize<Value>(
    config: RunnableConfig,
    params: ContextParams<Value>
  ): Promise<Context<Value>> {
    const instance = new Context<Value>(config, params);
    if (!instance.ctx) {
      throw new Error(
        "Context manager not found. Please initialize Context value with a context manager."
      );
    }
    instance.ctxGenerator = instance.ctx();
    const { value } = await instance.ctxGenerator.next();
    if (!value) {
      throw new Error(
        "Context manager did not yield a value. Please ensure your context manager yields a value."
      );
    }
    instance.value = value;
    return instance;
  }

  static of<Value>(
    ctx?: () => AsyncGenerator<Value, void, unknown>
  ): ConfiguredManagedValue<Value> {
    return {
      cls: Context,
      params: { ctx },
    };
  }

  call(_step: number): Value {
    if (this.value === undefined) {
      throw new EmptyChannelError();
    }
    return this.value;
  }

  async promises() {
    if (this.ctxGenerator) {
      const { done } = await this.ctxGenerator.return();
      if (!done) {
        throw new Error("Context manager did not successfully complete.");
      }
      
    } else {
      throw new Error(
        "Context manager not found. Please initialize Context value with a context manager."
      );
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function isContextManagedValue(value: unknown): value is Context<any> {
  return (
    typeof value === "object" &&
    value !== null &&
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (value as Context<any>).isContextManagedValue === true
  );
}

export function noopContext(): AsyncGenerator<undefined, void, unknown> {
  return (async function* () {
    yield;
  })();
}

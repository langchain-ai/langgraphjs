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

/**
 * Example implementation:
 * ```typescript
 * async function useContext() {
 *   // Define a context generator function
 *   async function* contextGenerator(): AsyncGenerator<string, void, unknown> {
 *     console.log("Context setup");
 *     yield "Initial value";
 *     console.log("Context cleanup");
 *   }
 *
 *   // Initialize the Context
 *   const context = await Context.initialize(
 *     {}, // RunnableConfig (empty in this example)
 *     { ctx: contextGenerator }
 *   );
 *
 *   try {
 *     let shouldContinue = true;
 *     while (shouldContinue) {
 *       // Use the context value
 *       console.log("Current value:", context.call(0));
 *
 *       // Perform your loop logic here
 *       // ...
 *
 *       // Call tick to see if we should continue
 *       shouldContinue = await context.tick();
 *     }
 *   } finally {
 *     // Cleanup
 *     await context.promises();
 *   }
 * }
 * ```
 */
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

  static async initialize<Value>(
    config: RunnableConfig,
    params: ContextParams<Value>
  ): Promise<Context<Value>> {
    const instance = new Context<Value>(config, params);
    if (!instance.ctx) {
      throw new Error(
        "Synchronous context manager not found. Please initialize Context value with a sync context manager, or invoke your graph asynchronously."
      );
    }
    const ctxGenerator = instance.ctx();
    const { value } = await ctxGenerator.next();
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
    // If there are any cleanup operations needed, they can be performed here
    if (this.ctx) {
      const ctxGenerator = this.ctx();
      const { value } = await ctxGenerator.return();
      if (!value) {
        throw new Error(
          "Context manager did not return a value. Please ensure your context manager returns a value."
        );
      }
      return value;
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

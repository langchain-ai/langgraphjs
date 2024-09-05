import { EmptyChannelError } from "../errors.js";
import { ManagedValue, ConfiguredManagedValue } from "./base.js";

// Type for a synchronous context manager
export type ContextManager<T> = {
    enter: () => T;
    exit: (exception?: any) => void | boolean;
};

// Type for an asynchronous context manager
export type AsyncContextManager<T> = {
    enter: () => Promise<T>;
    exit: (exception?: any) => Promise<void | boolean>;
};

export class Context<Value> extends ManagedValue<Value> {
    value?: Value;

    static of<Value>(
        ctx: ContextManager<Value> | null = null,
        actx: AsyncContextManager<Value> | null = null
    ): ConfiguredManagedValue {
        if (ctx === null && actx === null) {
            throw new Error("Must provide either sync or async context manager.");
        }
        return {
            cls: Context,
            kwargs: { ctx, actx }
        };
    }

    call(_step: number): Value {
        if (this.value === undefined) {
            throw new EmptyChannelError();
        }
        return this.value;
    }
}


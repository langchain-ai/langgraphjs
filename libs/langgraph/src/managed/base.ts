export abstract class ManagedValue<Value> {
    // Class body goes here
    abstract call(step: number): Value;
}

export type ConfiguredManagedValue = {
    cls: new (...args: any[]) => ManagedValue<any>;
    kwargs: { [key: string]: any };
};

export type ManagedValueSpec = typeof ManagedValue | ConfiguredManagedValue;
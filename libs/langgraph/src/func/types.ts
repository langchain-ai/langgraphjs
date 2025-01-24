export const finalSymbol = Symbol.for("__pregel_final");

/**
 * Allows the entrypoint function to return a value to the caller, as well as a separate state value to persist to the checkpoint
 */
export type EntrypointFinal<ValueT, SaveT> = {
  [finalSymbol]: {
    /**
     * The value to return to the caller
     */
    value?: ValueT;

    /**
     * The value to save to the checkpoint
     */
    save?: SaveT;
  };
};

export function isEntrypointFinal<ValueT, SaveT>(
  value: unknown
): value is EntrypointFinal<ValueT, SaveT> {
  return typeof value === "object" && value !== null && finalSymbol in value;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type EntrypointFuncReturnT<FuncT extends (...args: any[]) => any> =
  ReturnType<FuncT> extends
    | EntrypointFinal<infer SaveT, unknown>
    | Promise<EntrypointFinal<infer SaveT, unknown>>
    ? SaveT
    : ReturnType<FuncT>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type EntrypointFuncSaveT<FuncT extends (...args: any[]) => any> =
  ReturnType<FuncT> extends
    | EntrypointFinal<unknown, infer SaveT>
    | Promise<EntrypointFinal<unknown, infer SaveT>>
    ? SaveT
    : ReturnType<FuncT>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type EntrypointFuncFinalT<FuncT extends (...args: any[]) => any> =
  ReturnType<FuncT> extends
    | EntrypointFinal<infer ValueT, infer SaveT>
    | Promise<EntrypointFinal<infer ValueT, infer SaveT>>
    ? EntrypointFinal<ValueT, SaveT>
    : ReturnType<FuncT>;

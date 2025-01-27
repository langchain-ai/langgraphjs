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

export type EntrypointReturnT<OutputT> = OutputT extends
  | Generator<infer YieldT>
  | AsyncGenerator<infer YieldT>
  | Promise<Generator<infer YieldT>>
  | Promise<AsyncGenerator<infer YieldT>>
  ? YieldT extends EntrypointFinal<infer ValueT, unknown>
    ? ValueT
    : YieldT[]
  : OutputT extends
      | EntrypointFinal<infer ValueT, unknown>
      | Promise<EntrypointFinal<infer ValueT, unknown>>
  ? ValueT
  : OutputT;

export type EntrypointFuncSaveT<OutputT> = OutputT extends
  | EntrypointFinal<unknown, infer SaveT>
  | Promise<EntrypointFinal<unknown, infer SaveT>>
  ? SaveT
  : OutputT;

export type EntrypointFuncFinalT<OutputT> = OutputT extends
  | EntrypointFinal<infer ValueT, infer SaveT>
  | Promise<EntrypointFinal<infer ValueT, infer SaveT>>
  ? EntrypointFinal<ValueT, SaveT>
  : OutputT;

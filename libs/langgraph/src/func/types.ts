import { LangGraphRunnableConfig } from "../pregel/runnable_types.js";

/**
 * Allows the entrypoint function to return a value to the caller, as well as a separate state value to persist to the checkpoint
 */
export type EntrypointFinal<ValueT, SaveT> = {
  /**
   * The value to return to the caller
   */
  value?: ValueT;

  /**
   * The value to save to the checkpoint
   */
  save?: SaveT;

  __lg_type: "__pregel_final";
};

/**
 * Checks if a value is an EntrypointFinal - use this instead of `instanceof`, as value may have been deserialized
 * @param value The value to check
 * @returns Whether the value is an EntrypointFinal
 */
export function isEntrypointFinal<ValueT, SaveT>(
  value: unknown
): value is EntrypointFinal<ValueT, SaveT> {
  return (
    typeof value === "object" &&
    value !== null &&
    "__lg_type" in value &&
    value.__lg_type === "__pregel_final"
  );
}

/**
 * The return type of an entrypoint function.
 */
export type EntrypointReturnT<OutputT> = OutputT extends
  | EntrypointFinal<infer ValueT, unknown>
  | Promise<EntrypointFinal<infer ValueT, unknown>>
  ? ValueT
  : OutputT;

/**
 * The value to be saved when a function returns an EntrypointFinal.
 */
export type EntrypointFinalSaveT<OutputT> = OutputT extends
  | EntrypointFinal<unknown, infer SaveT>
  | Promise<EntrypointFinal<unknown, infer SaveT>>
  ? SaveT
  : OutputT;

/**
 * The value to be returned when a function returns an EntrypointFinal.
 */
export type EntrypointFinalValueT<OutputT> = OutputT extends
  | EntrypointFinal<infer ValueT, infer SaveT>
  | Promise<EntrypointFinal<infer ValueT, infer SaveT>>
  ? EntrypointFinal<ValueT, SaveT>
  : OutputT;

/**
 * Matches valid function signatures for entrypoints. Disallows generator functions.
 */
export type EntrypointFunc<InputT, OutputT> = OutputT extends AsyncGenerator<
  unknown,
  unknown,
  unknown
>
  ? never
  : OutputT extends Generator<unknown, unknown, unknown>
  ? never
  : (input: InputT, config: LangGraphRunnableConfig) => OutputT;

/**
 * Matches valid function signatures for tasks. Disallows generator functions.
 */
export type TaskFunc<
  ArgsT extends unknown[],
  OutputT
> = OutputT extends AsyncGenerator<unknown, unknown, unknown>
  ? never
  : OutputT extends Generator<unknown, unknown, unknown>
  ? never
  : (...args: ArgsT) => OutputT;

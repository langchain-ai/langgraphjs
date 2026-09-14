import { AsyncLocalStorageProviderSingleton } from "@langchain/core/singletons";
import { RunnableConfig } from "@langchain/core/runnables";
import {
  type JSONSchema,
  toJsonSchema,
} from "@langchain/core/utils/json_schema";
import {
  type InteropZodType,
  interopParse,
  isInteropZodSchema,
} from "@langchain/core/utils/types";
import {
  BaseCheckpointSaver,
  type PendingWrite,
} from "@langchain/langgraph-checkpoint";
import { GraphInterrupt, GraphValueError } from "./errors.js";
import {
  CONFIG_KEY_CHECKPOINT_NS,
  CONFIG_KEY_SCRATCHPAD,
  CONFIG_KEY_SEND,
  CONFIG_KEY_CHECKPOINTER,
  CHECKPOINT_NAMESPACE_SEPARATOR,
  RESUME,
  type Interrupt,
} from "./constants.js";
import { PregelScratchpad } from "./pregel/types.js";
import { XXH3 } from "./hash.js";

export interface InterruptOptions {
  /**
   * Schema for the value expected when the graph is resumed, surfaced to
   * clients on `Interrupt.response_schema` (as JSON Schema) so they can render
   * a typed input form. A Zod schema also parses the resume value, and the
   * parsed value is what `interrupt` returns; a JSON Schema object is passed
   * through to clients without validating the resume value.
   */
  responseSchema?: InteropZodType | JSONSchema;
}

/**
 * Interrupts the execution of a graph node.
 * This function can be used to pause execution of a node, and return the value of the `resume`
 * input when the graph is re-invoked using `Command`.
 * Multiple interrupts can be called within a single node, and each will be handled sequentially.
 *
 * When an interrupt is called:
 * 1. If there's a `resume` value available (from a previous `Command`), it returns that value.
 * 2. Otherwise, it throws a `GraphInterrupt` with the provided value
 * 3. The graph can be resumed by passing a `Command` with a `resume` value
 *
 * Because the `interrupt` function propagates by throwing a special `GraphInterrupt` error,
 * you should avoid using `try/catch` blocks around the `interrupt` function,
 * or if you do, ensure that the `GraphInterrupt` error is thrown again within your `catch` block.
 *
 * @param value - The value to include in the interrupt. This will be available in task.interrupts[].value
 * @param options - Optional settings. `responseSchema` describes the expected resume value and is
 *   available in task.interrupts[].response_schema as JSON Schema; a Zod schema also validates the resume value.
 * @returns The `resume` value provided when the graph is re-invoked with a Command, parsed by
 *   `responseSchema` when it is a Zod schema
 *
 * @example
 * ```typescript
 * // Define a node that uses multiple interrupts
 * const nodeWithInterrupts = () => {
 *   // First interrupt - will pause execution and include {value: 1} in task values
 *   const answer1 = interrupt({ value: 1 });
 *
 *   // Second interrupt - only called after first interrupt is resumed
 *   const answer2 = interrupt({ value: 2 });
 *
 *   // Use the resume values
 *   return { myKey: answer1 + " " + answer2 };
 * };
 *
 * // Resume the graph after first interrupt
 * await graph.stream(new Command({ resume: "answer 1" }));
 *
 * // Resume the graph after second interrupt
 * await graph.stream(new Command({ resume: "answer 2" }));
 * // Final result: { myKey: "answer 1 answer 2" }
 * ```
 *
 * @throws {Error} If called outside the context of a graph
 * @throws {GraphInterrupt} When no resume value is available
 * @throws {ZodError} When the resume value does not match a Zod `responseSchema`
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function interrupt<I = unknown, R = any>(
  value: I,
  options?: InterruptOptions
): R {
  const config: RunnableConfig | undefined =
    AsyncLocalStorageProviderSingleton.getRunnableConfig();
  if (!config) {
    throw new Error("Called interrupt() outside the context of a graph.");
  }

  const conf = config.configurable;
  if (!conf) {
    throw new Error("No configurable found in config");
  }

  const checkpointer: BaseCheckpointSaver = conf[CONFIG_KEY_CHECKPOINTER];
  if (!checkpointer) {
    throw new GraphValueError("No checkpointer set", {
      lc_error_code: "MISSING_CHECKPOINTER",
    });
  }

  const schema = options?.responseSchema;
  const parseResume = (resume: unknown): R =>
    (schema !== undefined && isInteropZodSchema(schema)
      ? interopParse(schema, resume)
      : resume) as R;

  // Track interrupt index
  const scratchpad: PregelScratchpad = conf[CONFIG_KEY_SCRATCHPAD];
  scratchpad.interruptCounter += 1;
  const idx = scratchpad.interruptCounter;

  // Find previous resume values
  if (scratchpad.resume.length > 0 && idx < scratchpad.resume.length) {
    const parsed = parseResume(scratchpad.resume[idx]);
    conf[CONFIG_KEY_SEND]?.([[RESUME, scratchpad.resume] as PendingWrite]);
    return parsed;
  }

  // Find current resume value
  if (scratchpad.nullResume !== undefined) {
    if (scratchpad.resume.length !== idx) {
      throw new Error(
        `Resume length mismatch: ${scratchpad.resume.length} !== ${idx}`
      );
    }
    const v = scratchpad.consumeNullResume();
    const parsed = parseResume(v);
    scratchpad.resume.push(v);
    conf[CONFIG_KEY_SEND]?.([[RESUME, scratchpad.resume] as PendingWrite]);
    return parsed;
  }

  // No resume value found
  const ns: string[] | undefined = conf[CONFIG_KEY_CHECKPOINT_NS]?.split(
    CHECKPOINT_NAMESPACE_SEPARATOR
  );

  const id = ns ? XXH3(ns.join(CHECKPOINT_NAMESPACE_SEPARATOR)) : undefined;
  const pending: Interrupt<I> = { id, value };
  if (schema !== undefined) {
    pending.response_schema = toJsonSchema(schema);
  }
  throw new GraphInterrupt([pending]);
}

type FilterAny<X> =
  (<T>() => T extends X ? 1 : 2) extends <
    T,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  >() => T extends any ? 1 : 2
    ? never
    : X;

export type InferInterruptInputType<T> = T extends typeof interrupt<
  infer I,
  unknown
>
  ? I
  : // eslint-disable-next-line @typescript-eslint/no-explicit-any
    T extends { [key: string]: typeof interrupt<any, any> }
    ? { [K in keyof T]: InferInterruptInputType<T[K]> }[keyof T]
    : unknown;

export type InferInterruptResumeType<
  T,
  TInner = false,
> = T extends typeof interrupt<never, infer R>
  ? TInner extends true
    ? FilterAny<R>
    : R
  : // eslint-disable-next-line @typescript-eslint/no-explicit-any
    T extends { [key: string]: typeof interrupt<any, any> }
    ? { [K in keyof T]: InferInterruptResumeType<T[K], true> }[keyof T]
    : unknown;

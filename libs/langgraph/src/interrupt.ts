import { AsyncLocalStorageProviderSingleton } from "@langchain/core/singletons";
import { CheckpointPendingWrite } from "@langchain/langgraph-checkpoint";
import { RunnableConfig } from "@langchain/core/runnables";
import { GraphInterrupt } from "./errors.js";
import {
  CONFIG_KEY_CHECKPOINT_NS,
  CONFIG_KEY_SCRATCHPAD,
  CONFIG_KEY_TASK_ID,
  CONFIG_KEY_WRITES,
  CONFIG_KEY_SEND,
  CHECKPOINT_NAMESPACE_SEPARATOR,
  NULL_TASK_ID,
  RESUME,
} from "./constants.js";
import { PregelScratchpad } from "./pregel/types.js";

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
 * @param value - The value to include in the interrupt. This will be available in task.interrupts[].value
 * @returns The `resume` value provided when the graph is re-invoked with a Command
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
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function interrupt<I = unknown, R = any>(value: I): R {
  const config: RunnableConfig | undefined =
    AsyncLocalStorageProviderSingleton.getRunnableConfig();
  if (!config) {
    throw new Error("Called interrupt() outside the context of a graph.");
  }

  // Track interrupt index
  const scratchpad: PregelScratchpad<R> =
    config.configurable?.[CONFIG_KEY_SCRATCHPAD];
  if (scratchpad.interruptCounter === undefined) {
    scratchpad.interruptCounter = 0;
  } else {
    scratchpad.interruptCounter += 1;
  }
  const idx = scratchpad.interruptCounter;

  // Find previous resume values
  const taskId = config.configurable?.[CONFIG_KEY_TASK_ID];
  const writes: CheckpointPendingWrite[] =
    config.configurable?.[CONFIG_KEY_WRITES] ?? [];

  if (!scratchpad.resume) {
    const newResume = (writes.find(
      (w) => w[0] === taskId && w[1] === RESUME
    )?.[2] || []) as R | R[];
    scratchpad.resume = Array.isArray(newResume) ? newResume : [newResume];
  }

  if (scratchpad.resume) {
    if (idx < scratchpad.resume.length) {
      return scratchpad.resume[idx];
    }
  }

  // Find current resume value
  if (!scratchpad.usedNullResume) {
    scratchpad.usedNullResume = true;
    const sortedWrites = [...writes].sort(
      (a, b) => b[0].localeCompare(a[0]) // Sort in reverse order
    );

    for (const [tid, c, v] of sortedWrites) {
      if (tid === NULL_TASK_ID && c === RESUME) {
        if (scratchpad.resume.length !== idx) {
          throw new Error(
            `Resume length mismatch: ${scratchpad.resume.length} !== ${idx}`
          );
        }
        scratchpad.resume.push(v as R);
        const send = config.configurable?.[CONFIG_KEY_SEND];
        if (send) {
          send([[RESUME, scratchpad.resume]]);
        }
        return v as R;
      }
    }
  }

  // No resume value found
  throw new GraphInterrupt([
    {
      value,
      when: "during",
      resumable: true,
      ns: config.configurable?.[CONFIG_KEY_CHECKPOINT_NS]?.split(
        CHECKPOINT_NAMESPACE_SEPARATOR
      ),
    },
  ]);
}

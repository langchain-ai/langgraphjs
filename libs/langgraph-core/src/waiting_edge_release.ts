import { AsyncLocalStorageProviderSingleton } from "@langchain/core/singletons";
import type { RunnableConfig } from "@langchain/core/runnables";
import { CONFIG_KEY_SCRATCHPAD } from "./constants.js";
import type { PregelScratchpad } from "./pregel/types.js";

/**
 * How an inclusive waiting edge released: the listed nodes that arrived and
 * the ones that never ran.
 */
export interface WaitingEdgeRelease {
  /** The node the edge feeds — the one currently running. */
  target: string;
  /** Listed nodes that completed and wrote to the edge. */
  arrived: string[];
  /** Listed nodes that never wrote to the edge. */
  missing: string[];
}

/**
 * Call inside a node to learn how the node came to run, when its trigger is
 * an inclusive waiting edge — `addEdge([...], target, { inclusive: true })` —
 * released at quiescence with only some of its listed nodes.
 *
 * Returns the arrived and missing node names, or `undefined` when the edge
 * released through ordinary completeness (every listed node ran) or the node
 * was not triggered by an inclusive edge at all — so a partial release is
 * distinguishable from a full one at the moment the target runs.
 *
 * The record is derived from the barrier itself each time tasks are prepared,
 * so it survives an `interruptBefore` on the target and a resume from a
 * checkpoint written in between.
 *
 * @example
 * ```ts
 * graph.addNode("index", (state) => {
 *   const release = waitingEdgeRelease();
 *   if (release) {
 *     // e.g. mark the result as built from release.arrived only
 *   }
 *   return { ... };
 * });
 * graph.addEdge(["ocr", "translate"], "index", { inclusive: true });
 * ```
 */
export function waitingEdgeRelease(): WaitingEdgeRelease | undefined {
  const config: RunnableConfig | undefined =
    AsyncLocalStorageProviderSingleton.getRunnableConfig();
  if (!config) {
    throw new Error(
      "Called waitingEdgeRelease() outside the context of a graph."
    );
  }
  const scratchpad = config.configurable?.[CONFIG_KEY_SCRATCHPAD] as
    | PregelScratchpad
    | undefined;
  return scratchpad?.waitingEdgeRelease;
}

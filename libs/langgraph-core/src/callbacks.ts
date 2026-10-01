import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { Interrupt } from "./constants.js";

const GRAPH_CALLBACK_HANDLER = Symbol.for("langgraph.graph_callback_handler");

/** Loop status at a graph lifecycle transition. */
export type GraphLifecycleStatus =
  | "pending"
  | "done"
  | "interrupt_before"
  | "interrupt_after"
  | "out_of_steps"
  | "draining";

/** A graph execution resumed from a checkpoint. */
export interface GraphResumeEvent {
  readonly runId: string | undefined;
  readonly status: GraphLifecycleStatus;
  readonly checkpointId: string;
  readonly checkpointNs: readonly string[];
}

/** The root graph paused. Static interrupts can have an empty payload list. */
export interface GraphInterruptEvent extends GraphResumeEvent {
  readonly interrupts: readonly Interrupt[];
}

export type GraphLifecycleEvent = GraphInterruptEvent | GraphResumeEvent;

/**
 * Extend this class and pass an instance through `callbacks` to observe graph
 * interrupts and resumes. Lifecycle methods are always awaited, including when
 * other callbacks run in the background. Set `raiseError` to propagate errors.
 *
 * @example
 * ```ts
 * class Observer extends GraphCallbackHandler {
 *   handleInterrupt(event: GraphInterruptEvent) {
 *     console.log(event.runId, event.interrupts);
 *   }
 * }
 * const observed = graph.withConfig({ callbacks: [new Observer()] });
 * ```
 */
export class GraphCallbackHandler extends BaseCallbackHandler {
  name = "GraphCallbackHandler";

  readonly [GRAPH_CALLBACK_HANDLER] = true;

  static isInstance(value: unknown): value is GraphCallbackHandler {
    return (
      typeof value === "object" &&
      value !== null &&
      GRAPH_CALLBACK_HANDLER in value &&
      value[GRAPH_CALLBACK_HANDLER] === true
    );
  }

  /** Called for root interrupts, before the terminal chain callback. */
  handleInterrupt?(event: GraphInterruptEvent): void | Promise<void>;

  /** Called before execution continues, including in resumed subgraphs. */
  handleResume?(event: GraphResumeEvent): void | Promise<void>;
}

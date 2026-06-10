// eslint-disable-next-line @typescript-eslint/no-unused-vars - needed to resolve below link
import type { GraphDrained } from "../errors.js";

/**
 * Run-scoped control surface for cooperative draining.
 *
 * Intended for a single graph run. Create a fresh {@link RunControl} per run;
 * reusing a control after {@link RunControl#requestDrain} leaves it drained.
 *
 * Safe to use from any concurrent context: the drain request is represented
 * by a single field write, so no synchronization is needed for this signal.
 * If more mutable state is added here, add synchronization.
 *
 * The intended use is hooking SIGTERM (or any external supervisor signal) to
 * {@link RunControl#requestDrain} so an in-flight graph run can stop cleanly
 * at the next superstep boundary and be resumed later from the saved
 * checkpoint.
 *
 * @example
 * ```typescript
 * import { RunControl, GraphDrained } from "@langchain/langgraph";
 *
 * const control = new RunControl();
 *
 * // In a signal handler, supervisor, etc.:
 * // control.requestDrain("sigterm");
 *
 * try {
 *   const result = await graph.invoke(input, { ...config, control });
 *   if (control.drainRequested) {
 *     // finished naturally on the same tick where drain was requested
 *   }
 * } catch (e) {
 *   if (e instanceof GraphDrained) {
 *     // checkpoint saved; resume later with the same config
 *   } else {
 *     throw e;
 *   }
 * }
 * ```
 */
export class RunControl {
  #drainReason: string | undefined = undefined;

  /**
   * Request that the current run drain cooperatively, stopping at the next
   * superstep boundary. Does not cancel work that is already running.
   *
   * @param reason - A short description of why the drain was requested.
   *   Surfaced on the resulting {@link GraphDrained} error.
   */
  requestDrain(reason: string = "shutdown"): void {
    this.#drainReason = reason;
  }

  /** Whether a drain has been requested for this run. */
  get drainRequested(): boolean {
    return this.#drainReason !== undefined;
  }

  /** The reason passed to {@link RunControl#requestDrain}, if any. */
  get drainReason(): string | undefined {
    return this.#drainReason;
  }
}

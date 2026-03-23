import { normalizeHitlInterruptPayload } from "./hitl-interrupt-payload.js";
import { Interrupt, ThreadState } from "../schema.js";

/**
 * Rewrites Python/API snake_case on interrupt `value` to JS camelCase for HITL.
 */
export function normalizeInterruptForClient<T = unknown>(
  interrupt: Interrupt<T>
): Interrupt<T> {
  if (interrupt.value === undefined) {
    return interrupt;
  }
  return {
    ...interrupt,
    value: normalizeHitlInterruptPayload(interrupt.value) as T,
  };
}

/**
 * Applies {@link normalizeInterruptForClient} to each interrupt.
 */
export function normalizeInterruptsList<T = unknown>(
  interrupts: Interrupt<T>[]
): Interrupt<T>[] {
  return interrupts.map((i) => normalizeInterruptForClient(i));
}

export function extractInterrupts<InterruptType = unknown>(
  values: unknown,
  options?: {
    isLoading: boolean;
    threadState: ThreadState | undefined;
    error: unknown;
  },
): Interrupt<InterruptType> | undefined {
  if (
    typeof values === "object" &&
    values != null &&
    "__interrupt__" in values &&
    Array.isArray(values.__interrupt__)
  ) {
    const valueInterrupts = values.__interrupt__ as Interrupt<InterruptType>[];
    if (valueInterrupts.length === 0) return { when: "breakpoint" };
    if (valueInterrupts.length === 1) {
      return normalizeInterruptForClient(valueInterrupts[0]);
    }

    // TODO: fix the typing of interrupts if multiple interrupts are returned
    const normalized = valueInterrupts.map((i) =>
      normalizeInterruptForClient(i)
    );
    return normalized as unknown as Interrupt<InterruptType> | undefined;
  }

  // If we're deferring to old interrupt detection logic, don't show the interrupt if the stream is loading
  if (options?.isLoading) return undefined;

  const interrupts = options?.threadState?.tasks?.at(-1)?.interrupts;
  if (interrupts == null || interrupts.length === 0) {
    // check if there's a next task present
    const next = options?.threadState?.next ?? [];
    if (!next.length || options?.error != null) return undefined;
    return { when: "breakpoint" };
  }

  // Return only the current interrupt
  return normalizeInterruptForClient(
    interrupts.at(-1) as Interrupt<InterruptType>
  );
}

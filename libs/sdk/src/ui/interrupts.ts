import { filterOutHeadlessToolInterrupts } from "../browser-tools.js";
import { Interrupt, ThreadState } from "../schema.js";

/**
 * `__interrupt__` entries meant for UI (excludes headless/browser tool
 * payloads, which the SDK consumes automatically).
 */
export function userFacingInterruptsFromValuesArray<InterruptType = unknown>(
  valueInterrupts: Interrupt<InterruptType>[]
): Interrupt<InterruptType>[] {
  if (valueInterrupts.length === 0) return [{ when: "breakpoint" }];
  const filtered = filterOutHeadlessToolInterrupts(valueInterrupts);
  if (filtered.length === 0) return [];
  return filtered;
}

/**
 * Task interrupts for display. Returns `null` when there are no task
 * interrupts (caller should fall through to breakpoint-style logic).
 */
export function userFacingInterruptsFromThreadTasks<InterruptType = unknown>(
  allInterrupts: Interrupt<InterruptType>[]
): Interrupt<InterruptType>[] | null {
  if (allInterrupts.length === 0) return null;
  const filtered = filterOutHeadlessToolInterrupts(allInterrupts);
  if (filtered.length === 0) return [];
  return filtered;
}

export function extractInterrupts<InterruptType = unknown>(
  values: unknown,
  options?: {
    isLoading: boolean;
    threadState: ThreadState | undefined;
    error: unknown;
  }
): Interrupt<InterruptType> | undefined {
  if (
    typeof values === "object" &&
    values != null &&
    "__interrupt__" in values &&
    Array.isArray(values.__interrupt__)
  ) {
    const valueInterrupts = values.__interrupt__ as Interrupt<InterruptType>[];
    if (valueInterrupts.length === 0) return { when: "breakpoint" };

    const filtered = filterOutHeadlessToolInterrupts(valueInterrupts);
    if (filtered.length === 0) return undefined;
    if (filtered.length === 1) return filtered[0];

    // TODO: fix the typing of interrupts if multiple interrupts are returned
    return filtered as unknown as Interrupt<InterruptType> | undefined;
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

  const filtered = filterOutHeadlessToolInterrupts(
    interrupts as Interrupt<InterruptType>[]
  );
  if (filtered.length === 0) {
    const next = options?.threadState?.next ?? [];
    if (!next.length || options?.error != null) return undefined;
    return { when: "breakpoint" };
  }

  // Return only the current interrupt
  return filtered.at(-1) as Interrupt<InterruptType> | undefined;
}

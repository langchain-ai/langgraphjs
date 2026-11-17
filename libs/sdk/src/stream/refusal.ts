/**
 * Why a server with strict resume refused an answer: the interrupts it named
 * that aren't open (`interruptIds`) and the ones still waiting (`pendingIds`).
 */
export interface StrictResumeRefusal {
  reason: string;
  interruptIds: string[];
  pendingIds: string[];
}

/**
 * The error `respond()` and `respondAll()` report on `error` when a server
 * with strict resume refuses the answer.
 */
export type UnknownInterruptError = Error &
  StrictResumeRefusal & { name: "UnknownInterruptError" };

export function isUnknownInterruptError(
  error: unknown
): error is UnknownInterruptError {
  return (
    typeof error === "object" &&
    error != null &&
    (error as { name?: unknown }).name === "UnknownInterruptError"
  );
}

/** The refusal a root `failed` lifecycle event carries, if it has one. */
export function toRefusal(data: unknown): StrictResumeRefusal | undefined {
  if (data == null || typeof data !== "object") return undefined;
  const { reason, interrupt_ids, pending_ids } = data as {
    reason?: unknown;
    interrupt_ids?: unknown;
    pending_ids?: unknown;
  };
  if (typeof reason !== "string") return undefined;
  const ids = (value: unknown) =>
    Array.isArray(value)
      ? value.filter((id): id is string => typeof id === "string")
      : [];
  return {
    reason,
    interruptIds: ids(interrupt_ids),
    pendingIds: ids(pending_ids),
  };
}

export function unknownInterruptError(
  message: string,
  refusal: StrictResumeRefusal
): UnknownInterruptError {
  return Object.assign(new Error(message), {
    name: "UnknownInterruptError" as const,
    ...refusal,
  });
}

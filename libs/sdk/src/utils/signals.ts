export function mergeSignals(...signals: (AbortSignal | null | undefined)[]) {
  const nonZeroSignals = signals.filter(
    (signal): signal is AbortSignal => signal != null
  );

  if (nonZeroSignals.length === 0) return undefined;
  if (nonZeroSignals.length === 1) return nonZeroSignals[0];
  // AbortSignal.any adds no listener to the inputs, so a caller signal shared by
  // many requests doesn't collect them. Safari before 17.4 and Node before 20.3
  // lack it; the merge below holds its listeners until an input aborts.
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any(nonZeroSignals);
  }

  const controller = new AbortController();
  const aborted = nonZeroSignals.find((signal) => signal.aborted);
  if (aborted) {
    controller.abort(aborted.reason);
    return controller.signal;
  }

  const onAbort = (event: Event) => {
    for (const signal of nonZeroSignals) {
      signal.removeEventListener("abort", onAbort);
    }
    controller.abort((event.target as AbortSignal).reason);
  };
  for (const signal of nonZeroSignals) {
    signal.addEventListener("abort", onAbort);
  }

  return controller.signal;
}

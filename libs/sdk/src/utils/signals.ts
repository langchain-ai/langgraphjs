export function mergeSignals(...signals: (AbortSignal | null | undefined)[]) {
  const nonZeroSignals = [
    ...new Set(
      signals.filter((signal): signal is AbortSignal => signal != null)
    ),
  ];

  if (nonZeroSignals.length === 0) return undefined;
  if (nonZeroSignals.length === 1) return nonZeroSignals[0];

  const controller = new AbortController();
  const abortedSignal = nonZeroSignals.find((signal) => signal.aborted);
  if (abortedSignal) {
    controller.abort(abortedSignal.reason);
    return controller.signal;
  }

  const onAbort = (event: Event) => {
    for (const signal of nonZeroSignals) {
      signal.removeEventListener("abort", onAbort);
    }
    controller.abort((event.target as AbortSignal).reason);
  };

  for (const signal of nonZeroSignals) {
    signal.addEventListener("abort", onAbort, { once: true });
  }

  return controller.signal;
}

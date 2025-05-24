export const combineAbortSignals = (
  ...input: (AbortSignal | undefined | null)[]
) => {
  const signals = input.filter((item): item is AbortSignal => item != null);

  if ("any" in AbortSignal) return AbortSignal.any(signals);

  const abortController = new AbortController();
  signals.forEach((signal) =>
    signal.addEventListener("abort", () => abortController.abort()),
  );
  return abortController.signal;
};

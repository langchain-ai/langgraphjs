import * as coreErrors from "@langchain/core/errors";

type ErrorClass = new (message?: string) => Error;

const ExpectedCancellation: ErrorClass =
  (coreErrors as { ExpectedCancellation?: ErrorClass }).ExpectedCancellation ??
  Error;

export class RunCancellation extends ExpectedCancellation {
  readonly action: "interrupt" | "rollback";

  constructor(action: "interrupt" | "rollback") {
    super(`Run cancelled (${action})`);
    this.name = "RunCancellation";
    this.action = action;
  }
}

export const combineAbortSignals = (
  ...input: (AbortSignal | undefined | null)[]
) => {
  const signals = input.filter((item): item is AbortSignal => item != null);

  if ("any" in AbortSignal) return AbortSignal.any(signals);

  const abortController = new AbortController();
  signals.forEach((signal) =>
    signal.addEventListener("abort", () => abortController.abort())
  );
  return abortController.signal;
};

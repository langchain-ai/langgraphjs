import { RunnableSequence, Runnable } from "@langchain/core/runnables";
import type { Pregel } from "../index.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isRunnableSequence(
  x: RunnableSequence | Runnable
): x is RunnableSequence {
  return "steps" in x && Array.isArray(x.steps);
}
function isPregel(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  x: Pregel<any, any> | Runnable
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): x is Pregel<any, any> {
  return (
    "inputChannels" in x &&
    x.inputChannels !== undefined &&
    "outputChannels" &&
    x.outputChannels !== undefined
  );
}

export function findSubgraphPregel(
  candidate: Runnable
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Pregel<any, any> | undefined {
  const candidates = [candidate];
  for (const candidate of candidates) {
    if (isPregel(candidate)) {
      return candidate;
    } else if (isRunnableSequence(candidate)) {
      candidates.push(...candidate.steps);
    }
  }
  return undefined;
}

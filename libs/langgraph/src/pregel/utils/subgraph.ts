import {
  RunnableSequence,
  Runnable,
  RunnableLike,
} from "@langchain/core/runnables";
import type { PregelInterface } from "../types.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isRunnableSequence(
  x: RunnableSequence | Runnable
): x is RunnableSequence {
  return "steps" in x && Array.isArray(x.steps);
}

export function isPregelLike(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  x: PregelInterface<any, any> | RunnableLike<any, any, any>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): x is PregelInterface<any, any> {
  return "lg_is_pregel" in x && x.lg_is_pregel === true;
}

export function findSubgraphPregel(
  candidate: Runnable
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): PregelInterface<any, any> | undefined {
  const candidates = [candidate];
  for (const candidate of candidates) {
    if (isPregelLike(candidate)) {
      return candidate;
    } else if (isRunnableSequence(candidate)) {
      candidates.push(...candidate.steps);
    }
  }
  return undefined;
}

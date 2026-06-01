import { useEffect, useState } from "react";
import type { UseStreamReturn } from "@langchain/react";

import type { agent as reactAgentType } from "../agents/react-agent";

/**
 * Window after hook mount during which a transition to `isLoading=true`
 * is attributed to hydrate() re-attaching to a pre-existing in-flight
 * run, rather than to a user-initiated submit in this session.
 */
const ATTACH_OBSERVATION_WINDOW_MS = 5_000;

export type ReattachVerdict =
  | "no-thread"
  | "observing"
  | "attached-to-in-flight"
  | "hydrated-idle";

export interface ReattachStatus {
  verdict: ReattachVerdict;
  mountedAt: number;
  threadIdAtMount: string | null;
  firstLoadingObservedAt: number | null;
  submittedThisSession: boolean;
}

/**
 * Observes the hook's lifecycle from mount and emits a verdict about
 * whether `controller.hydrate(threadId)` picked up a pre-existing
 * in-flight run.
 *
 * Heuristic:
 *   - If we mounted without a threadId → "no-thread".
 *   - If `isLoading` becomes true within the observation window BEFORE
 *     the user submitted in this session → "attached-to-in-flight".
 *   - If the window elapses without a local submit and without an
 *     observed loading transition → "hydrated-idle".
 *   - Otherwise → "observing" until the verdict settles.
 */
export function useReattachStatus(
  stream: UseStreamReturn<typeof reactAgentType>,
  {
    threadIdAtMount,
    submittedThisSession,
  }: { threadIdAtMount: string | null; submittedThisSession: boolean }
): ReattachStatus {
  const [mountedAt] = useState(() => Date.now());
  const [firstLoadingObservedAt, setFirstLoadingObservedAt] = useState<
    number | null
  >(null);
  const [windowElapsed, setWindowElapsed] = useState(false);

  useEffect(() => {
    if (stream.isLoading && firstLoadingObservedAt == null) {
      setFirstLoadingObservedAt(Date.now());
    }
  }, [stream.isLoading, firstLoadingObservedAt]);

  useEffect(() => {
    const timer = setTimeout(() => {
      setWindowElapsed(true);
    }, ATTACH_OBSERVATION_WINDOW_MS);
    return () => clearTimeout(timer);
  }, []);

  let verdict: ReattachVerdict;
  if (threadIdAtMount == null) {
    verdict = "no-thread";
  } else if (
    firstLoadingObservedAt != null &&
    firstLoadingObservedAt - mountedAt < ATTACH_OBSERVATION_WINDOW_MS &&
    !submittedThisSession
  ) {
    verdict = "attached-to-in-flight";
  } else if (windowElapsed && !submittedThisSession) {
    verdict = "hydrated-idle";
  } else {
    verdict = "observing";
  }

  return {
    verdict,
    mountedAt,
    threadIdAtMount,
    firstLoadingObservedAt,
    submittedThisSession,
  };
}
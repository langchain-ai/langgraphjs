"use client";

import { useState, useRef, useCallback } from "react";

export const useControllableThreadId = (options?: {
  threadId?: string | null;
  onThreadId?: (threadId: string) => void;
}): [string | null, (threadId: string | null) => void] => {
  const [localThreadId, _setLocalThreadId] = useState<string | null>(
    options?.threadId ?? null,
  );

  const onThreadIdRef = useRef(options?.onThreadId);
  onThreadIdRef.current = options?.onThreadId;

  const setThreadId = useCallback((threadId: string | null) => {
    _setLocalThreadId(threadId);
    if (threadId != null) onThreadIdRef.current?.(threadId);
  }, []);

  if (!options || !("threadId" in options)) {
    return [localThreadId, setThreadId];
  }

  return [options.threadId ?? null, setThreadId];
};

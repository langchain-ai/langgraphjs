"use client";

import { useCallback, useState } from "react";

export function useThreadIdParam() {
  const [threadId, setThreadId] = useState<string | undefined>(() => {
    if (typeof window === "undefined") return undefined;
    return (
      new URLSearchParams(window.location.search).get("threadId") ?? undefined
    );
  });

  const updateThreadId = useCallback((newThreadId?: string | null) => {
    setThreadId(newThreadId ?? undefined);

    const url = new URL(window.location.href);
    if (newThreadId == null) {
      url.searchParams.delete("threadId");
    } else {
      url.searchParams.set("threadId", newThreadId);
    }
    window.history.replaceState({}, "", url.toString());
  }, []);

  return [threadId, updateThreadId] as const;
}

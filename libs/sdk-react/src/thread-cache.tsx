"use client";

import { createContext, useState, type ReactNode } from "react";
import { ThreadCache } from "@langchain/langgraph-sdk/ui";

export const ThreadCacheContext = createContext<ThreadCache | undefined>(
  undefined
);

/**
 * Keeps what the thread loads of every `useStream` and `useSuspenseStream`
 * inside it read, so a thread opened again shows at once while it is read
 * again. Wrap the part of the app whose streams read the same server as the
 * same user, and key it by that user, so a new user starts with an empty
 * cache.
 *
 * ```tsx
 * <ThreadCacheProvider key={userId}>
 *   <App />
 * </ThreadCacheProvider>
 * ```
 */
export function ThreadCacheProvider({
  maxBytes,
  children,
}: {
  /**
   * The most it holds, as characters of strings, 32 M by default. Threads
   * opened least recently go first.
   */
  maxBytes?: number;
  children: ReactNode;
}) {
  const [cache] = useState(() => new ThreadCache({ maxBytes }));
  return (
    <ThreadCacheContext.Provider value={cache}>
      {children}
    </ThreadCacheContext.Provider>
  );
}

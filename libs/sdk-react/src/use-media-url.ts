/* __LC_ALLOW_ENTRYPOINT_SIDE_EFFECTS__ */

"use client";

import { useEffect, useState } from "react";
import type { MediaBase } from "@langchain/langgraph-sdk/stream";

/**
 * Resolve the lazy {@link MediaBase.objectURL} promise into a string
 * suitable for direct use in `<audio src>` / `<img src>` /
 * `<video src>` / `<a href download>`. Returns `undefined` until the
 * URL is available.
 *
 * Lifecycle:
 *  - On mount (or when `media` changes) the hook awaits
 *    `media.objectURL`, then commits the resolved string to state.
 *  - On unmount (or when `media` changes) the hook calls
 *    `media.revoke()` to free the object URL slot. The next consumer
 *    that accesses `media.objectURL` mints a fresh URL from the same
 *    `Blob`, so live re-renders just work.
 *  - If the underlying handle errored before settling, the promise
 *    rejects and `useMediaURL` stays at `undefined`. Inspect
 *    `media.error` to surface the failure.
 *
 * Pair with {@link useAudio} / {@link useImages} / {@link useVideo} /
 * {@link useFiles} to bridge SDK media handles into React DOM nodes
 * without manual `URL.createObjectURL` bookkeeping.
 */
export function useMediaURL(media: MediaBase | undefined): string | undefined {
  const [url, setUrl] = useState<string>();

  useEffect(() => {
    if (media == null) {
      setUrl(undefined);
      return undefined;
    }
    let cancelled = false;
    media.objectURL.then(
      (resolved) => {
        if (!cancelled) setUrl(resolved);
      },
      () => {
        // Errors surfaced via `media.error`; keep `url` undefined so
        // consumers fall through to a no-src render.
      }
    );
    return () => {
      cancelled = true;
      setUrl(undefined);
      try {
        media.revoke();
      } catch {
        // best-effort
      }
    };
  }, [media]);

  return url;
}

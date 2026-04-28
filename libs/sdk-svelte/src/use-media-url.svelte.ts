import type { MediaBase } from "@langchain/langgraph-sdk/stream";
import type { ReactiveValue, ValueOrGetter } from "./use-projection.svelte.js";

function unwrap<T>(input: ValueOrGetter<T>): T {
  if (typeof input === "function") return (input as () => T)();
  return input;
}

/**
 * Resolve the lazy {@link MediaBase.objectURL} promise into a
 * reactive string suitable for `<audio src>`, `<img src>`,
 * `<video src>`, or `<a download href>`. Reads `.current` for the
 * latest URL, or `undefined` until the promise settles.
 *
 * Lifecycle:
 *  - On first `$effect` (or whenever the supplied `media` value
 *    changes), awaits `media.objectURL` and commits the resolved
 *    string to state.
 *  - On cleanup (or when `media` changes), calls `media.revoke()` to
 *    free the blob-URL slot. The next consumer that accesses
 *    `media.objectURL` mints a fresh URL from the same `Blob`, so
 *    live re-renders just work.
 *  - If the underlying handle errored before settling, the URL stays
 *    `undefined`. Surface the failure via `media.error`.
 *
 * `media` accepts a raw handle or a getter so the composable rebinds
 * automatically to the latest media without a manual effect at the
 * call site.
 */
export function useMediaURL(
  media: ValueOrGetter<MediaBase | undefined>
): ReactiveValue<string | undefined> {
  let url = $state<string | undefined>(undefined);

  $effect(() => {
    const next = unwrap(media);
    if (next == null) {
      url = undefined;
      return;
    }
    let cancelled = false;
    next.objectURL.then(
      (resolved) => {
        if (!cancelled) url = resolved;
      },
      () => {
        // Errors surface via `media.error`; keep `url` undefined so
        // consumers fall through to a no-src render.
      }
    );
    return () => {
      cancelled = true;
      url = undefined;
      try {
        next.revoke();
      } catch {
        // best-effort
      }
    };
  });

  return {
    get current() {
      return url;
    },
  };
}

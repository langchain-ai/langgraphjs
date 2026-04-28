import {
  effect,
  isSignal,
  signal,
  untracked,
  type Signal,
} from "@angular/core";
import type { MediaBase } from "@langchain/langgraph-sdk/stream";

/**
 * Resolve the lazy {@link MediaBase.objectURL} promise into a string
 * suitable for direct use in `<audio src>` / `<img src>` /
 * `<video src>` / `<a href download>`. Returns `undefined` until the
 * URL is available.
 *
 * Lifecycle:
 *  - On first read (or when `media` changes) the helper awaits
 *    `media.objectURL`, then commits the resolved string to the
 *    returned signal.
 *  - On destroy (or when `media` changes) the helper calls
 *    `media.revoke()` to free the object URL slot. The next consumer
 *    that accesses `media.objectURL` mints a fresh URL from the same
 *    `Blob`, so live re-renders just work.
 *  - If the underlying handle errored before settling, the promise
 *    rejects and `injectMediaUrl` stays at `undefined`. Inspect
 *    `media.error` to surface the failure.
 *
 * Pair with {@link injectAudio} / {@link injectImages} /
 * {@link injectVideo} / {@link injectFiles} to bridge SDK media
 * handles into Angular templates without manual
 * `URL.createObjectURL` bookkeeping.
 *
 * `media` accepts a plain handle or a `Signal<MediaBase | undefined>`
 * so callers can feed a `computed(() => stream.audio()[0])`.
 */
export function injectMediaUrl(
  media: MediaBase | undefined | Signal<MediaBase | undefined>
): Signal<string | undefined> {
  const url = signal<string | undefined>(undefined);

  const read = isSignal(media)
    ? (media as Signal<MediaBase | undefined>)
    : () => media as MediaBase | undefined;

  effect((onCleanup) => {
    const next = (read as () => MediaBase | undefined)();

    untracked(() => {
      url.set(undefined);
      if (next == null) return;

      let cancelled = false;
      next.objectURL.then(
        (resolved) => {
          if (!cancelled) url.set(resolved);
        },
        () => {
          // Errors surfaced via `media.error`; keep `url` undefined
          // so consumers fall through to a no-src render.
        }
      );

      onCleanup(() => {
        cancelled = true;
        try {
          next.revoke();
        } catch {
          // best-effort
        }
      });
    });
  });

  return url;
}

import {
  ref,
  watch,
  onScopeDispose,
  toValue,
  type MaybeRefOrGetter,
  type Ref,
} from "vue";
import type { MediaBase } from "@langchain/langgraph-sdk/stream";

/**
 * Resolve the lazy {@link MediaBase.objectURL} promise into a
 * reactive string suitable for `<audio src>`, `<img src>`,
 * `<video src>`, or `<a download href>`. Returns `undefined` until
 * the URL is available.
 *
 * Lifecycle:
 *  - On setup (or whenever the supplied `media` value changes), the
 *    composable awaits `media.objectURL` and commits the resolved
 *    string to state.
 *  - On scope disposal (or when `media` changes), the composable
 *    calls `media.revoke()` to free the blob URL slot. The next
 *    consumer that accesses `media.objectURL` mints a fresh URL from
 *    the same `Blob`, so live re-renders just work.
 *  - If the underlying handle errored before settling, the URL stays
 *    `undefined`. Surface the failure via `media.error`.
 *
 * `media` accepts a raw handle, a `Ref<MediaBase | undefined>`, or a
 * getter, so the composable can rebind automatically to the latest
 * media without a manual watcher at the call site.
 */
export function useMediaURL(
  media: MaybeRefOrGetter<MediaBase | undefined>
): Readonly<Ref<string | undefined>> {
  const url = ref<string | undefined>();

  let currentMedia: MediaBase | undefined;
  let cancelled = false;

  const detach = () => {
    cancelled = true;
    if (currentMedia != null) {
      try {
        currentMedia.revoke();
      } catch {
        // best-effort
      }
    }
    currentMedia = undefined;
    url.value = undefined;
  };

  watch(
    () => toValue(media),
    (next) => {
      detach();
      if (next == null) return;
      cancelled = false;
      currentMedia = next;
      next.objectURL.then(
        (resolved) => {
          if (!cancelled) url.value = resolved;
        },
        () => {
          // Errors surfaced via `media.error`; keep `url` undefined
          // so consumers fall through to a no-src render.
        }
      );
    },
    { immediate: true }
  );

  onScopeDispose(detach);

  return url;
}

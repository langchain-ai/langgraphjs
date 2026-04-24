## Media

`useAudio`, `useImages`, `useVideo`, and `useFiles` assemble multimodal blocks from the protocol stream (see [Selector composables](./selector-composables.md)). Each returns an array of media handles — one per message containing a matching block in the target namespace — with a live-growing `partialBytes` buffer during streaming and a settled `blob` / `objectURL` once the message finishes.

### `useMediaURL`

`useMediaURL` resolves a media handle to a short-lived `blob:` URL that is revoked on unmount. Pass a getter so the URL tracks the handle reactively.

```svelte
<script lang="ts">
  import { useImages, useMediaURL } from "@langchain/svelte";
  const images = useImages(stream);
</script>

{#each images.current as img (img.id)}
  {@const url = useMediaURL(() => img)}
  <img src={url.current} alt="" />
{/each}
```

### `useAudioPlayer` / `useVideoPlayer`

Wrap a media handle with reactive playback state — `isPlaying`, `currentTime`, `duration` — plus imperative `play()`, `pause()`, and `seek()` methods:

```svelte
<script lang="ts">
  import { useAudio, useAudioPlayer } from "@langchain/svelte";
  const audio = useAudio(stream);
</script>

{#each audio.current as clip (clip.id)}
  {@const player = useAudioPlayer(() => clip)}
  <button onclick={() => player.play()} disabled={player.isPlaying}>Play</button>
  <button onclick={() => player.pause()}>Pause</button>
  <progress value={player.currentTime} max={player.duration} />
{/each}
```

The player handle owns a single `HTMLAudioElement` / `HTMLVideoElement` per mount. It is cleaned up automatically when the component unmounts or the underlying handle changes.

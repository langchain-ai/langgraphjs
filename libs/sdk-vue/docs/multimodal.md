# Multimodal media

Audio, images, video, and arbitrary files streamed from the agent
surface through dedicated selectors and ship with ready-to-use
composables for `<img>` / `<audio>` / `<video>` sources plus a
Web-Audio–based PCM player.

## Selectors

| Selector | Returns |
|---|---|
| `useAudio(stream, target?)` | `AudioMedia[]` |
| `useImages(stream, target?)` | `ImageMedia[]` |
| `useVideo(stream, target?)` | `VideoMedia[]` |
| `useFiles(stream, target?)` | `FileMedia[]` |

Each media handle carries:

- `partialBytes` — live-growing byte buffer during streaming.
- `blob` / `objectURL` — settled on `message-finish`.
- `error` — fail-loud error surface.
- Media-specific extras (`transcript` for audio, `width` / `height`
  for images, …).

## Helpers

- `useMediaURL(handle)` — creates a stable blob URL suitable for
  `<audio / img / video src>`. Owns the `objectURL` lifecycle — URLs
  are created on demand and revoked when the host scope unmounts or
  the input media changes.
- `useAudioPlayer(handle, options?)` — PCM-to-`AudioContext` player
  with play / pause / seek state.
- `useVideoPlayer(handle, options?)` — opinionated `<video>`-element
  player with play / pause / seek state.

## Example

```vue
<script setup lang="ts">
import { useStream, useAudio, useAudioPlayer, useMediaURL } from "@langchain/vue";
import { computed } from "vue";

const stream = useStream({ assistantId: "agent", apiUrl: "http://localhost:2024" });
const audio = useAudio(stream);
const latest = computed(() => audio.value.at(-1));
const player = useAudioPlayer(latest);
const downloadUrl = useMediaURL(latest);
</script>

<template>
  <button v-if="latest" @click="player.status === 'playing' ? player.pause() : player.play()">
    {{ player.status === "playing" ? "Pause" : "Play" }}
  </button>
  <a v-if="downloadUrl" :href="downloadUrl" download>
    Download
  </a>
</template>
```

## Scoping to subagents

All four selectors accept the same `target` argument as every other
selector — pass a `SubagentDiscoverySnapshot` (or a ref / getter to
one) to stream media produced by a specific subagent:

```ts
const media = useImages(stream, () => props.subagent);
```

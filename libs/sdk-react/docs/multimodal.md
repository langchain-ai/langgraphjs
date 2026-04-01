# Multimodal media

`useAudio`, `useImages`, `useVideo`, and `useFiles` assemble multimodal blocks from the protocol stream. Each hook returns an array of media handles (one per message containing a matching block in the target namespace).

## Table of contents

- [Handle shape](#handle-shape)
- [Media hooks](#media-hooks)
- [`useMediaURL`](#usemediaurl)
- [`useAudioPlayer` / `useVideoPlayer`](#useaudioplayer--usevideoplayer)

## Handle shape

Every media handle exposes the same core fields, plus media-specific extras:

| Field          | Type                      | Description                                       |
| -------------- | ------------------------- | ------------------------------------------------- |
| `id`           | `string`                  | Stable id for the media block.                    |
| `messageId`    | `string`                  | Owning message id.                                |
| `partialBytes` | `Uint8Array \| undefined` | Live-growing byte buffer during streaming.        |
| `blob`         | `Blob \| undefined`       | Settled `Blob` — populated on `message-finish`.   |
| `objectURL`    | `string \| undefined`     | Object URL for the settled `Blob` (auto-revoked). |
| `error`        | `unknown`                 | Fail-loud error surface.                          |
| `mimeType`     | `string \| undefined`     | Declared MIME type.                               |

Media-specific extras:

| Hook        | Extras                                                            |
| ----------- | ----------------------------------------------------------------- |
| `useAudio`  | `transcript?: string`, `duration?: number`, `sampleRate?: number` |
| `useImages` | `width?: number`, `height?: number`                               |
| `useVideo`  | `duration?: number`, `width?: number`, `height?: number`          |
| `useFiles`  | `filename?: string`, `size?: number`                              |

## Media hooks

```tsx
import { useAudio, useImages, useVideo, useFiles } from "@langchain/react";

const audios = useAudio(stream);
const images = useImages(stream);
const videos = useVideo(stream);
const files = useFiles(stream);
```

Each accepts an optional `target` argument (subagent / subgraph / `{ namespace }`) to scope the subscription — see [Companion selector hooks](./selectors.md#how-targeting-works).

## `useMediaURL`

Turns a media handle into a stable blob URL you can pass to `<audio/img/video src>`:

```tsx
import { useAudio, useMediaURL } from "@langchain/react";

function AudioReply({ stream }: { stream: AnyStream }) {
  const audios = useAudio(stream);
  const latest = audios.at(-1);
  const url = useMediaURL(latest);
  return url ? <audio controls src={url} /> : null;
}
```

`useMediaURL(undefined)` returns `undefined` — safe to call unconditionally.

## `useAudioPlayer` / `useVideoPlayer`

Opinionated player handles with play/pause/seek state, built on top of the media hooks:

```tsx
import { useAudio, useAudioPlayer } from "@langchain/react";

function AudioPlayer({ stream }: { stream: AnyStream }) {
  const audio = useAudio(stream).at(-1);
  const player = useAudioPlayer(audio, { autoPlay: true });

  return (
    <div>
      <button onClick={player.toggle}>
        {player.isPlaying ? "Pause" : "Play"}
      </button>
      <progress value={player.currentTime} max={player.duration} />
    </div>
  );
}
```

`useVideoPlayer` mirrors the same shape for video handles.

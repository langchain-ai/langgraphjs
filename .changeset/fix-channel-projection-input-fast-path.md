---
"@langchain/langgraph-sdk": patch
---

fix(sdk): deliver input channel events on the root-bus fast path

`channelProjection` with `replay: false` (the `useChannelEffect` default) compared `event.method` to channel names, so `input.requested` never matched `"input"`. Match via `inferChannel` instead, same as the slow path.

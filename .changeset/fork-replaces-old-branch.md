---
"@langchain/langgraph-sdk": patch
---

After `submit(input, { forkFrom })`, `messages` shows only the new branch. A fork's checkpoints restart at a lower step, so they were treated as an old replay and merged add-only, which kept every message from the abandoned branch until a reload. Also, `useMessageMetadata(...).parentCheckpointId` now keeps the parent of the first checkpoint that carried each message, instead of moving every message to the latest checkpoint's parent, so forking from it edits the right message.

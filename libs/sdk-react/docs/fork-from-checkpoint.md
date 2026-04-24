# Fork / edit from a checkpoint

The pre-v1 `branch` / `setBranch` / `experimental_branchTree` API is gone. Forking is now expressed as **"submit from the parent checkpoint of a specific message"**.

## Table of contents

- [Mental model](#mental-model)
- [Example: edit a user turn](#example-edit-a-user-turn)
- [Example: retry an AI turn](#example-retry-an-ai-turn)
- [Related](#related)

## Mental model

Two pieces work together:

1. **`useMessageMetadata(stream, msgId)`** — returns `{ parentCheckpointId }` for the given message, or `undefined` until it loads. See [Companion selector hooks](./selectors.md#usemessagemetadata).
2. **`submit(input, { forkFrom: { checkpointId } })`** — dispatches a new run whose initial checkpoint is `checkpointId`, replacing anything that happened after it on the thread.

You pick a message, read its **parent** checkpoint, and submit from there with new input. The new turn becomes the canonical continuation of the thread — old messages after the fork point are superseded.

## Example: edit a user turn

```tsx
import {
  useStream,
  useMessageMetadata,
  type AnyStream,
} from "@langchain/react";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";

function EditButton({
  stream,
  message,
  newContent,
}: {
  stream: AnyStream;
  message: BaseMessage;
  newContent: string;
}) {
  const metadata = useMessageMetadata(stream, message.id);

  return (
    <button
      disabled={!metadata?.parentCheckpointId}
      onClick={() =>
        stream.submit(
          { messages: [new HumanMessage(newContent)] },
          { forkFrom: { checkpointId: metadata!.parentCheckpointId } },
        )
      }
    >
      Save edit
    </button>
  );
}
```

## Example: retry an AI turn

To retry the last AI turn, fork from the parent checkpoint of the **preceding human message** and re-submit the same input:

```tsx
function Retry({ stream }: { stream: AnyStream }) {
  const lastHuman = [...stream.messages]
    .reverse()
    .find((m) => m.type === "human");
  const metadata = useMessageMetadata(stream, lastHuman?.id);

  return (
    <button
      disabled={!metadata?.parentCheckpointId || !lastHuman}
      onClick={() =>
        stream.submit(
          { messages: [lastHuman!] },
          { forkFrom: { checkpointId: metadata!.parentCheckpointId } },
        )
      }
    >
      Retry
    </button>
  );
}
```

## Related

- [`useStream` — `submit()` options](./use-stream.md#submit-options)
- [`useMessageMetadata`](./selectors.md#usemessagemetadata)

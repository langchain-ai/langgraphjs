# Fork from a checkpoint

To edit a message or retry an answer, submit again from the checkpoint right before that message: the new run replaces what came after it, and the thread keeps the old version as a branch.

## Table of contents

- [How it works](#how-it-works)
- [When fork points arrive](#when-fork-points-arrive)
- [Example: edit a user message](#example-edit-a-user-message)
- [Example: retry the last answer](#example-retry-the-last-answer)
- [Related](#related)

## How it works

Two pieces work together:

1. **`useMessageMetadata(stream, messageId)`** gives the message's `parentCheckpointId`: the checkpoint right before the message first appeared.
2. **`submit(input, { forkFrom })`** starts a run from that checkpoint instead of the thread's latest.

## When fork points arrive

Fork points are read from the thread's history, one small request, while a `useMessageMetadata` hook is mounted: when the thread loads and when each run ends. So:

- a message that is still streaming has no `parentCheckpointId` yet,
- a message more than about 500 steps back gets none.

Disable the edit button while `parentCheckpointId` is missing, as the examples below do.

## Example: edit a user message

```tsx
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { useMessageMetadata, type AnyStream } from "@langchain/react";

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
  const forkFrom = metadata?.parentCheckpointId;

  return (
    <button
      disabled={forkFrom == null}
      onClick={() =>
        void stream.submit({ messages: [new HumanMessage(newContent)] }, { forkFrom })
      }
    >
      Save edit
    </button>
  );
}
```

## Example: retry the last answer

To get a new answer to the last question, fork from the checkpoint before that question and send it again:

```tsx
function Retry({ stream }: { stream: AnyStream }) {
  const lastHuman = [...stream.messages]
    .reverse()
    .find((message) => message.getType() === "human");
  const metadata = useMessageMetadata(stream, lastHuman?.id);
  const forkFrom = metadata?.parentCheckpointId;

  return (
    <button
      disabled={forkFrom == null || lastHuman == null}
      onClick={() => {
        if (lastHuman == null) return;
        void stream.submit({ messages: [lastHuman] }, { forkFrom });
      }}
    >
      Retry
    </button>
  );
}
```

## Related

- [`useStream`'s `submit()`](./use-stream.md#submit)
- [`useMessageMetadata`](./selectors.md#usemessagemetadata)

# Forking from a message (branching)

The legacy `branch` / `setBranch` / `fetchStateHistory` trio has been
replaced by **per-message metadata + `submit({ forkFrom })`**. Mount
`injectMessageMetadata` next to the message you want to fork from,
read its `parentCheckpointId`, and pass it to `submit`:

```typescript
import { Component, Input } from "@angular/core";
import type { BaseMessage, HumanMessage } from "@langchain/core/messages";
import {
  injectMessageMetadata,
  injectStream,
} from "@langchain/angular";

@Component({
  standalone: true,
  template: `
    <button
      [disabled]="!metadata()?.parentCheckpointId"
      (click)="editFromHere()"
    >
      Edit from here
    </button>
  `,
})
export class EditButtonComponent {
  @Input({ required: true }) message!: BaseMessage;

  readonly stream = injectStream();
  readonly metadata = injectMessageMetadata(
    this.stream,
    () => this.message.id,
  );

  editFromHere() {
    const checkpointId = this.metadata()?.parentCheckpointId;
    if (!checkpointId) return;
    void this.stream.submit(
      { messages: [{ type: "human", content: "…revised prompt…" }] },
      { forkFrom: { checkpointId } },
    );
  }
}
```

## What `parentCheckpointId` means

Every message assembled by the stream carries metadata describing the
checkpoint **before** it was produced. Forking from that checkpoint
rewinds the thread to the state immediately prior to the message —
any new submission from there produces an alternate branch without
mutating the original run history on the server.

## Why the old API was removed

The 0.x branching helpers (`branch`, `setBranch`,
`fetchStateHistory`) required the controller to preload and index the
full checkpoint tree up front. `injectMessageMetadata` is
**ref-counted and lazy** — checkpoint metadata is only materialized
for messages that currently have an "Edit" button mounted, which
scales cleanly to long threads.

## Related

- [`injectMessageMetadata`](./selectors.md) — the selector used above
- [Submission queue](./submission-queue.md) — forking a queued run
- [`v1-migration.md`](./v1-migration.md) §3 for the full rename map

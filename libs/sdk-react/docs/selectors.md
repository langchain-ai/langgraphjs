# Companion selector hooks

The root [`useStream`](./use-stream.md) hook exposes always-on projections (`values`, `messages`, `toolCalls`, `interrupts`, `error`, `isLoading`, discovery maps). Anything else — scoped subagent state, message metadata, submission queue, raw channels, media — is available through the companion selector hooks.

Each selector hook opens a **ref-counted subscription** when the first component mounts it and releases it when the last consumer unmounts. Root calls (no target) are free — they read the already-mounted root projection directly.

## Table of contents

- [How targeting works](#how-targeting-works)
- [Full hook list](#full-hook-list)
- [Root vs. scoped example](#root-vs-scoped-example)
- [`useMessageMetadata`](#usemessagemetadata)
- [`useChannel`](#usechannel)
- [`useExtension`](#useextension)
- [`useSubmissionQueue`](#usesubmissionqueue)
- [Related](#related)

## How targeting works

All scoped selectors accept a `target` argument. Valid targets are:

- **`undefined`** (or omitted) — the root namespace. Free read.
- **A `SubagentDiscoverySnapshot`** — as exposed via `stream.subagents.values()`.
- **A `SubgraphDiscoverySnapshot`** — as exposed via `stream.subgraphs` / `stream.subgraphsByNode`.
- **`{ namespace: string[] }`** — an explicit namespace, useful for custom routing.

Subscriptions open on mount and close when the last consumer for a given `(channel, namespace)` tuple unmounts. Components that don't render a subagent's content never pay for its wire traffic.

## Full hook list

| Hook                                                                    | Returns                                                          | Use for                                                                    |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `useValues(stream, target?)`                                            | `StateType` (root) / `T \| undefined` (scoped)                   | Arbitrary state / scoped snapshot.                                         |
| `useMessages(stream, target?)`                                          | `BaseMessage[]`                                                  | Message stream, root or scoped.                                            |
| `useToolCalls(stream, target?)`                                         | `AssembledToolCall[]`                                            | Tool-call stream, with per-call `status`.                                  |
| `useMessageMetadata(stream, msgId)`                                     | `{ parentCheckpointId } \| undefined`                            | Powers fork / edit flows. See [Fork](./fork-from-checkpoint.md).           |
| `useSubmissionQueue(stream)`                                            | `{ entries, size, cancel, clear }`                               | Reactive client-side submission queue. See [queue](./submission-queue.md). |
| `useExtension(stream, name, target?)`                                   | `T \| undefined`                                                 | Read a named `custom:<name>` extension.                                    |
| `useChannel(stream, channels, target?, options?)`                       | `Event[]`                                                        | Low-level raw-events escape hatch.                                         |
| `useAudio` / `useImages` / `useVideo` / `useFiles`                      | `AudioMedia[]` / `ImageMedia[]` / `VideoMedia[]` / `FileMedia[]` | Assembled multimodal streams. See [Multimodal](./multimodal.md).           |
| `useMediaURL(handle)`                                                   | `string \| undefined`                                            | Turns a media handle into an `<img/audio/video src>` URL.                  |
| `useAudioPlayer(handle, options?)` / `useVideoPlayer(handle, options?)` | Player handles                                                   | Opinionated playback helpers built on top of the media hooks.              |

## Root vs. scoped example

```tsx
import {
  useStream,
  useMessages,
  useToolCalls,
  useValues,
  type AnyStream,
  type SubagentDiscoverySnapshot,
} from "@langchain/react";

function Chat() {
  const stream = useStream({ assistantId: "agent", apiUrl: "/api" });

  // Root projections — identical to `stream.messages` / `stream.values`.
  // These calls are free: no new subscription is opened.
  const rootMessages = useMessages(stream);
  const rootValues = useValues(stream);

  return (
    <>
      <ThreadView messages={rootMessages} />
      {[...stream.subagents.values()].map((s) => (
        <SubagentCard key={s.id} stream={stream} subagent={s} />
      ))}
    </>
  );
}

function SubagentCard({
  stream,
  subagent,
}: {
  stream: AnyStream;
  subagent: SubagentDiscoverySnapshot;
}) {
  // Scoped: opens a namespaced subscription for this subagent only.
  const messages = useMessages(stream, subagent);
  const toolCalls = useToolCalls(stream, subagent);
  const values = useValues<ResearcherState>(stream, subagent);

  return (
    <section>
      <header>
        {subagent.name} — {subagent.status}
      </header>
      {messages.map((m) => (
        <Bubble key={m.id} msg={m} />
      ))}
    </section>
  );
}
```

## `useMessageMetadata`

Returns `{ parentCheckpointId }` (and `undefined` while loading). Use to drive fork / edit UIs:

```tsx
import { useMessageMetadata } from "@langchain/react";

function EditButton({ stream, message }) {
  const metadata = useMessageMetadata(stream, message.id);

  return (
    <button
      disabled={!metadata?.parentCheckpointId}
      onClick={() =>
        stream.submit(
          { messages: [new HumanMessage("...revised prompt...")] },
          { forkFrom: { checkpointId: metadata!.parentCheckpointId } },
        )
      }
    >
      Edit from here
    </button>
  );
}
```

See [Fork / edit from a checkpoint](./fork-from-checkpoint.md) for the full flow.

## `useChannel`

Escape hatch to the raw protocol event stream. Subscribe to one or more channels and get the buffered events as an array:

```tsx
const events = useChannel(stream, ["values", "updates"]);
```

Pass `target` (subagent / subgraph / `{ namespace }`) to scope. Useful for bespoke reducers that can't be expressed through `useValues` / `useMessages`.

## `useExtension`

Read a single custom extension (wire-level `custom:<name>` channel) as a reactive snapshot:

```tsx
const telemetry = useExtension<Telemetry>(stream, "telemetry");
```

## `useSubmissionQueue`

Observes the client-side submission queue. See [Submission queue](./submission-queue.md) for details.

## Related

- [`useStream` return values](./use-stream.md#return-values)
- [Subagents & subgraphs](./subagents.md)
- [Multimodal media](./multimodal.md)

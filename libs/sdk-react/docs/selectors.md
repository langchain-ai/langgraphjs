# Selector hooks

[`useStream`](./use-stream.md) gives the main conversation. The selector hooks read the same stream. With no target they return the main conversation's data and cost nothing. With a target, a subagent, a subgraph or a namespace, they hold that target's view while they are mounted.

## Table of contents

- [Targets](#targets)
- [The hooks](#the-hooks)
- [The main conversation and a subagent](#the-main-conversation-and-a-subagent)
- [`useMessageMetadata`](#usemessagemetadata)
- [`useChannel`](#usechannel)
- [`useChannelEffect`](#usechanneleffect)
- [`useSubmissionQueue`](#usesubmissionqueue)
- [Related](#related)

## Targets

A selector hook's `target` is one of:

- nothing, `null` or `[]`: the main conversation,
- a `SubagentDiscoverySnapshot` from `stream.subagents`,
- a `SubgraphDiscoverySnapshot` from `stream.subgraphs` or `stream.subgraphsByNode`,
- a namespace, as `{ namespace: [...] }` or as the array itself.

While a hook holds a target, that target's events stream to it. On Agent Server 0.19 or later, the open panels of a run share one connection that carries only their subagents. On an older server they read from the run's own stream. When the last hook on a target unmounts, its view is released. After a reload, the first hook on a subagent looks up its namespace with one small history read.

## The hooks

| Hook                                              | Returns                                                         | Use for                                                     |
| ------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------- |
| `useMessages(stream, target?)`                    | `BaseMessage[]`                                                 | Messages, as class instances.                               |
| `useToolCalls(stream, target?)`                   | `AssembledToolCall[]`                                           | Tool calls, each with its `status` and result.              |
| `useValues(stream, target?, options?)`            | `StateType` (main conversation), `T \| undefined` (a target)    | State. With a target, annotate its shape: `useValues<ResearcherState>(stream, subagent)`. |
| `useMessageMetadata(stream, messageId)`           | `{ parentCheckpointId, optimisticStatus? } \| undefined`         | Edit and retry, and a sent message's status.                |
| `useSubmissionQueue(stream)`                      | `{ entries, size, cancel, clear }`                              | Submits waiting for the current run.                        |
| `useChannel(stream, channels, target?, options?)` | `Event[]`                                                       | Raw events, to render.                                      |
| `useChannelEffect(stream, channels, options)`     | `void`                                                          | Raw events, for side effects such as analytics.             |

## The main conversation and a subagent

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

  // The main conversation: the same as stream.messages, with no subscription.
  const messages = useMessages(stream);

  return (
    <>
      <ThreadView messages={messages} />
      {[...stream.subagents.values()].map((subagent) => (
        <SubagentCard key={subagent.id} stream={stream} subagent={subagent} />
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
  // A subagent: streams while this card is mounted.
  const messages = useMessages(stream, subagent);
  const toolCalls = useToolCalls(stream, subagent);
  const values = useValues<ResearcherState>(stream, subagent);

  return (
    <section>
      <header>
        {subagent.name}: {subagent.status}, {toolCalls.length} tool calls
      </header>
      {messages.map((message) => (
        <Bubble key={message.id} message={message} />
      ))}
    </section>
  );
}
```

## `useMessageMetadata`

`useMessageMetadata(stream, messageId)` returns a message's metadata, or `undefined` before there is any:

- `parentCheckpointId`: the checkpoint to fork from to edit the message, the one right before it first appeared. It is read from the thread's history while a `useMessageMetadata` hook is mounted, when a run ends and when the thread loads, so a message that is still streaming has none. Messages more than about 500 steps back get none.
- `optimisticStatus`: for a message this page sent, `"pending"` until the run's state holds it, then `"sent"`, or `"failed"` when the run fails or is stopped first.

```tsx
import { HumanMessage } from "@langchain/core/messages";
import { useMessageMetadata, type AnyStream } from "@langchain/react";

function EditButton({ stream, messageId }: { stream: AnyStream; messageId: string }) {
  const metadata = useMessageMetadata(stream, messageId);
  const forkFrom = metadata?.parentCheckpointId;

  return (
    <button
      disabled={forkFrom == null}
      onClick={() =>
        void stream.submit(
          { messages: [new HumanMessage("...revised prompt...")] },
          { forkFrom }
        )
      }
    >
      Edit from here
    </button>
  );
}
```

See [Fork from a checkpoint](./fork-from-checkpoint.md) for the full flow.

## `useChannel`

`useChannel(stream, channels, target?, options?)` returns the events of `channels` since the hook mounted, at the target's namespace or one level below it, oldest first. It keeps at most `options.bufferSize` events (4096 by default) and drops them when the stream moves to another thread. `options.replay` is deprecated and does nothing.

```tsx
const events = useChannel(stream, ["custom"]);
```

Each event is `{ method, params: { namespace, timestamp, data } }`, where `namespace` is `[]` for the main graph and `timestamp` is when the page received the event. `data` depends on the channel:

| Channel     | `params.data`                                                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `values`    | The state after a step.                                                                                                               |
| `updates`   | What each node returned in a step.                                                                                                    |
| `messages`  | `[chunk, metadata]`: a message chunk, and the metadata of the node that streamed it.                                                  |
| `custom`    | `{ payload }`: what the graph wrote with its stream writer.                                                                           |
| `tools`     | `tool-started` (`tool_call_id`, `tool_name`, `input`), `tool-progress` (`data`), `tool-finished` (`output`) or `tool-error` (`message`), in `event`. |
| `lifecycle` | `{ event, cause?, error? }`: `started`, `completed`, `failed` or `interrupted` for subagents and subgraphs, and one event when a run ends. |

A hook on `tools` adds tool events to the runs that start after it mounts, so a run already streaming sends it none. Tool events need Agent Server 0.19 or later. For messages, tool calls and values, prefer `useMessages`, `useToolCalls` and `useValues`.

## `useChannelEffect`

`useChannel` is for events you render. To act on each event instead, to send analytics or write a log, use `useChannelEffect`. It calls `onEvent` once per event and never renders the component:

```tsx
import { useChannelEffect } from "@langchain/react";

useChannelEffect(stream, ["lifecycle", "tools"], {
  onEvent(event) {
    sendAnalytics(event);
  },
  onError(error) {
    logger.error(error);
  },
});
```

| Option       | Default               | Description                                                                 |
| ------------ | --------------------- | --------------------------------------------------------------------------- |
| `onEvent`    |                       | Required. Called with each event from when the hook mounts.                 |
| `onError`    |                       | Called when `onEvent` throws. Without it, the error is logged.              |
| `target`     | the main conversation | A subagent, a subgraph or a namespace.                                      |
| `enabled`    | `true`                | Set to `false` to pause, for example while another thread shows.            |
| `replay`     |                       | Deprecated, and does nothing.                                               |
| `bufferSize` |                       | Deprecated, and does nothing.                                               |

`onEvent` and `onError` are read from the latest render, so inline functions are fine and never subscribe again.

## `useSubmissionQueue`

`useSubmissionQueue(stream)` lists the submits waiting for the current run, with `cancel(id)` and `clear()`. See [Submission queue](./submission-queue.md).

## Related

- [`useStream`'s return values](./use-stream.md#return-values)
- [Subagents and subgraphs](./subagents.md)
- [Fork from a checkpoint](./fork-from-checkpoint.md)

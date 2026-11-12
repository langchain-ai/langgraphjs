# @langchain/react

React hooks for building AI applications with [Deep Agents](https://docs.langchain.com/oss/javascript/deepagents/overview), [LangChain](https://docs.langchain.com/oss/javascript/langchain/overview) and [LangGraph](https://docs.langchain.com/oss/javascript/langgraph/overview).

`useStream` connects a component to an agent on a LangGraph Agent Server. It loads a thread, streams its runs, and gives you the thread's messages, state, tool calls, interrupts and subagents. Selector hooks give the views you need only in some places: a subagent's messages, the submission queue, a message's fork point, raw events.

## Highlights

- **Runs survive reloads.** A run keeps going when the tab closes, and loading the thread joins it. Runs started in another tab or by a cron show as they stream.
- **Subagent panels on demand.** A subagent's messages stream only while a component that shows them is mounted.
- **A queue, and answers that wait.** A message sent during a run waits in the server's queue, and an answer to an interrupt never cuts a run short.
- **Types from your agent.** `useStream<typeof agent>()` types the state, the tool calls and the subagents.
- **Suspense.** `useSuspenseStream` suspends while the thread loads.
- **Your own backend.** A custom transport points the hooks at a server that runs the graph itself.

## Installation

```bash
npm install @langchain/react @langchain/core
```

**Peer dependencies:** `react` (^18 || ^19), `@langchain/core` (^1.1.48).

## Quick start

```tsx
import { useStream } from "@langchain/react";

function Chat() {
  const { messages, submit, isLoading } = useStream({
    assistantId: "agent",
    apiUrl: "http://localhost:2024",
  });

  return (
    <div>
      {messages.map((message, i) => (
        <div key={message.id ?? i}>{message.text}</div>
      ))}

      <button
        disabled={isLoading}
        onClick={() =>
          void submit({
            messages: [{ type: "human", content: "Hello!" }],
          })
        }
      >
        Send
      </button>
    </div>
  );
}
```

## How it fits together

1. **`useStream`** loads the thread and streams its runs. It gives the main conversation, the interrupts, and the subagents and subgraphs the runs start. Mount it once per thread.
2. **The selector hooks** read the same stream. With no target they return the main conversation's data at no cost. With a subagent, a subgraph or a namespace, they stream that target while they are mounted.

```tsx
import { useStream, useMessages, useSubmissionQueue } from "@langchain/react";

function Chat() {
  const stream = useStream({ assistantId: "agent", apiUrl: "/api" });

  // The main conversation: the same as stream.messages.
  const messages = useMessages(stream);

  // The submits waiting for the current run.
  const queue = useSubmissionQueue(stream);
}
```

## Documentation

The guides are in [`./docs`](./docs/). Start with:

- **[`useStream`](./docs/use-stream.md):** options, return values, `submit()`, `stop()`, `respond()`, `hydrate()`.
- **[Selector hooks](./docs/selectors.md):** `useMessages`, `useToolCalls`, `useValues`, `useMessageMetadata`, `useChannel` and the rest.

Then, by feature:

- **[Interrupts and headless tools](./docs/interrupts.md):** answering interrupts, and tools that run in the browser.
- **[Submission queue](./docs/submission-queue.md):** messages sent during a run, and `useSubmissionQueue`.
- **[Subagents and subgraphs](./docs/subagents.md):** snapshots, and showing what a subagent says.
- **[Fork from a checkpoint](./docs/fork-from-checkpoint.md):** editing a message or retrying an answer.
- **[`useSuspenseStream`](./docs/suspense.md):** Suspense and error boundaries.
- **[`StreamProvider` and `useStreamContext`](./docs/context.md):** one stream for a component tree.
- **[Type safety](./docs/type-safety.md):** types from your agent, and the type helpers.
- **[Transports](./docs/transports.md):** the Agent Server, headers and auth.
- **[Custom transports](./docs/custom-transport.md):** your own backend.

## Upgrading from 1.x

2.0 keeps 1.x's hooks, their names and their arguments, on a new streaming engine, so most apps upgrade by changing the version. [`v2-migration.md`](./docs/v2-migration.md) lists everything that changed, and how to get 1.x's behavior back.

## Playground

For complete end-to-end examples with full agentic UIs, visit the [LangChain UI Playground](https://docs.langchain.com/playground).

## License

MIT

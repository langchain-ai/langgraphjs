# `useSuspenseStream`

`useSuspenseStream` is [`useStream`](./use-stream.md) for React Suspense: the component suspends while its thread loads, and a thread that fails to load goes to the nearest error boundary.

## Table of contents

- [Basic usage](#basic-usage)
- [What it returns](#what-it-returns)
- [Errors](#errors)
- [Thread switches](#thread-switches)

## Basic usage

```tsx
import { Suspense } from "react";
import { ErrorBoundary } from "react-error-boundary";
import { useSuspenseStream } from "@langchain/react";

function App() {
  return (
    <ErrorBoundary fallback={<ErrorDisplay />}>
      <Suspense fallback={<Spinner />}>
        <Chat threadId={threadId} />
      </Suspense>
    </ErrorBoundary>
  );
}

function Chat({ threadId }: { threadId: string | null }) {
  const { messages, submit, isStreaming } = useSuspenseStream({
    assistantId: "agent",
    apiUrl: "http://localhost:2024",
    threadId,
  });

  return (
    <>
      {messages.map((message, i) => (
        <div key={message.id ?? i}>{message.text}</div>
      ))}
      {isStreaming && <TypingIndicator />}
    </>
  );
}
```

The thread is read once, also when the component suspends before it mounts.

## What it returns

The same as `useStream`, with two differences:

- no `isLoading`, `isThreadLoading` or `hydrationPromise`, since Suspense shows the load,
- `isStreaming`, which is `true` while a run streams.

The [selector hooks](./selectors.md) accept its result, as they accept `useStream`'s.

## Errors

- A thread that fails to load throws to the nearest error boundary.
- A run that fails sets `error` and throws nothing, so the conversation stays on screen. To send it to the error boundary too, throw it yourself: `if (error) throw error;`.

## Thread switches

A new `threadId` suspends the component again while that thread loads:

```tsx
<Suspense fallback={<Spinner />}>
  <Chat threadId={selectedThreadId} />
</Suspense>
```

To drive your own loading UI instead, use [`useStream`](./use-stream.md) and its `isThreadLoading` and `hydrationPromise`.

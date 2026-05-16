# `useSuspenseStream`

`useSuspenseStream` hands the initial hydration phase to `<Suspense>` and any non-streaming error to the nearest Error Boundary. It is a slim v1-native port that wraps [`useStream`](./use-stream.md) and leans on `hydrationPromise` to integrate with React's concurrent machinery.

## Table of contents

- [Basic usage](#basic-usage)
- [Return shape](#return-shape)
- [Thread switches](#thread-switches)
- [Differences from `useStream`](#differences-from-usestream)

## Basic usage

```tsx
import { Suspense } from "react";
import { ErrorBoundary } from "react-error-boundary";
import { useSuspenseStream } from "@langchain/react";

function App() {
  return (
    <ErrorBoundary fallback={<ErrorDisplay />}>
      <Suspense fallback={<Spinner />}>
        <Chat />
      </Suspense>
    </ErrorBoundary>
  );
}

function Chat() {
  const { messages, submit, isStreaming } = useSuspenseStream({
    assistantId: "agent",
    apiUrl: "http://localhost:2024",
  });

  return (
    <>
      {messages.map((m, i) => (
        <div key={m.id ?? i}>{String(m.content)}</div>
      ))}
      {isStreaming && <TypingIndicator />}
    </>
  );
}
```

Behaviour:

- **Initial hydration** suspends. `<Spinner />` renders until the first snapshot lands.
- **Non-streaming errors** (hydration failures, transport setup errors) throw and route to the nearest Error Boundary.
- **Streaming errors** still surface on `stream.error` so you can decide whether to re-throw or display inline.

## Return shape

`useSuspenseStream` returns the same handle as `useStream`, with three differences:

| Change                                                     | Reason                                           |
| ---------------------------------------------------------- | ------------------------------------------------ |
| `isLoading`, `isThreadLoading`, `hydrationPromise` removed | Handled by `<Suspense>`.                         |
| `isStreaming: boolean` added                               | Indicates whether tokens are currently arriving. |
| `error` still present but non-streaming errors throw       | Routed to the nearest Error Boundary.            |

All other fields (`values`, `messages`, `toolCalls`, `interrupt` / `interrupts`, `subagents`, `submit`, `stop`, `respond`, `getThread`, `client`, `assistantId`, …) work exactly as they do on `useStream`.

## Thread switches

Changing the `threadId` prop re-suspends the component while the new thread hydrates. The existing Error Boundary and Suspense fallback handle the transition naturally:

```tsx
<Suspense fallback={<Spinner />}>
  <Chat threadId={selectedThreadId} />
</Suspense>
```

A fresh `hydrationPromise` is installed internally on every `threadId` change; the suspended render resumes once it settles.

## Differences from `useStream`

If you need manual control over hydration or don't want to involve React's concurrent machinery, use [`useStream`](./use-stream.md) and drive your own loading UI from `isLoading` / `isThreadLoading` / `error` / `hydrationPromise`.

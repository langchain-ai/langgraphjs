# @langchain/angular

Angular SDK for building AI-powered applications with [LangChain](https://js.langchain.com/) and [LangGraph](https://langchain-ai.github.io/langgraphjs/). Provides a `useStream` function that manages streaming, state, branching, and interrupts using Angular's Signals API.

## Installation

```bash
npm install @langchain/angular @langchain/core
```

**Peer dependencies:** `@angular/core` (^18.0.0 - ^21.0.0), `@langchain/core` (^1.0.1)

## Quick Start

```typescript
import { Component } from "@angular/core";
import { useStream } from "@langchain/angular";

@Component({
  standalone: true,
  template: `
    <div>
      @for (msg of stream.messages(); track msg.id ?? $index) {
        <div>{{ str(msg.content) }}</div>
      }

      <button
        [disabled]="stream.isLoading()"
        (click)="onSubmit()"
      >
        Send
      </button>
    </div>
  `,
})
export class ChatComponent {
  stream = useStream({
    assistantId: "agent",
    apiUrl: "http://localhost:2024",
  });

  str(v: unknown) {
    return typeof v === "string" ? v : JSON.stringify(v);
  }

  onSubmit() {
    void this.stream.submit({
      messages: [{ type: "human", content: "Hello!" }],
    });
  }
}
```

## `useStream` Options

| Option | Type | Description |
|---|---|---|
| `assistantId` | `string` | **Required.** The assistant/graph ID to stream from. |
| `apiUrl` | `string` | Base URL of the LangGraph API. |
| `client` | `Client` | Pre-configured `Client` instance (alternative to `apiUrl`). |
| `messagesKey` | `string` | State key containing messages. Defaults to `"messages"`. |
| `initialValues` | `StateType` | Initial state values before any stream data arrives. |
| `fetchStateHistory` | `boolean \| { limit: number }` | Fetch thread history on stream completion. Enables branching. |
| `throttle` | `boolean \| number` | Throttle state updates for performance. |
| `onFinish` | `(state, error?) => void` | Called when the stream completes. |
| `onError` | `(error, state?) => void` | Called on stream errors. |
| `onThreadId` | `(threadId) => void` | Called when a new thread is created. |
| `onUpdateEvent` | `(event) => void` | Receive update events from the stream. |
| `onCustomEvent` | `(event) => void` | Receive custom events from the stream. |
| `onStop` | `() => void` | Called when the stream is stopped by the user. |

## Return Values

All reactive properties are Angular `Signal` or `WritableSignal` values.

| Property | Type | Description |
|---|---|---|
| `values` | `Signal<StateType>` | Current graph state. |
| `messages` | `Signal<Message[]>` | Messages from the current state. |
| `isLoading` | `Signal<boolean>` | Whether a stream is currently active. |
| `error` | `Signal<unknown>` | The most recent error, if any. |
| `interrupt` | `Signal<Interrupt \| undefined>` | Current interrupt requiring user input. |
| `branch` | `WritableSignal<string>` | Active branch identifier. |
| `submit(values, options?)` | `function` | Submit new input to the graph. When called while a stream is active, the run is created on the server with `multitaskStrategy: "enqueue"` and queued automatically. |
| `stop()` | `function` | Cancel the active stream. |
| `setBranch(branch)` | `function` | Switch to a different conversation branch. |
| `getMessagesMetadata(msg, index?)` | `function` | Get branching and checkpoint metadata for a message. |
| `switchThread(id)` | `(id: string \| null) => void` | Switch to a different thread. Pass `null` to start a new thread on next submit. |
| `queue.entries` | `Signal<ReadonlyArray<QueueEntry>>` | Pending server-side runs. Each entry has `id` (server run ID), `values`, `options`, and `createdAt`. |
| `queue.size` | `Signal<number>` | Number of pending runs on the server. |
| `queue.cancel(id)` | `(id: string) => Promise<boolean>` | Cancel a pending run on the server by its run ID. |
| `queue.clear()` | `() => Promise<void>` | Cancel all pending runs on the server. |

## Type Safety

Provide your state type as a generic parameter:

```typescript
import type { BaseMessage } from "langchain";

interface MyState {
  messages: BaseMessage[];
  context?: string;
}

@Component({ /* ... */ })
export class ChatComponent {
  stream = useStream<MyState>({
    assistantId: "my-graph",
    apiUrl: "http://localhost:2024",
  });
}
```

### Typed Interrupts

```typescript
import type { BaseMessage } from "langchain";

@Component({ /* ... */ })
export class ChatComponent {
  stream = useStream<
    { messages: BaseMessage[] },
    { InterruptType: { question: string } }
  >({
    assistantId: "my-graph",
    apiUrl: "http://localhost:2024",
  });

  // this.stream.interrupt() is typed as { question: string } | undefined
}
```

## Handling Interrupts

```typescript
import { Component } from "@angular/core";
import type { BaseMessage } from "langchain";
import { useStream } from "@langchain/angular";

@Component({
  standalone: true,
  template: `
    <div>
      @for (msg of stream.messages(); track msg.id ?? $index) {
        <div>{{ str(msg.content) }}</div>
      }

      @if (stream.interrupt()) {
        <div>
          <p>{{ stream.interrupt()!.value.question }}</p>
          <button (click)="onResume()">Approve</button>
        </div>
      }

      <button (click)="onSubmit()">Send</button>
    </div>
  `,
})
export class ChatComponent {
  stream = useStream<
    { messages: BaseMessage[] },
    { InterruptType: { question: string } }
  >({
    assistantId: "agent",
    apiUrl: "http://localhost:2024",
  });

  str(v: unknown) {
    return typeof v === "string" ? v : JSON.stringify(v);
  }

  onSubmit() {
    void this.stream.submit({
      messages: [{ type: "human", content: "Hello" }],
    });
  }

  onResume() {
    void this.stream.submit(null, { command: { resume: "Approved" } });
  }
}
```

## Branching

Enable conversation branching with `fetchStateHistory: true`:

```typescript
import { Component } from "@angular/core";
import { useStream } from "@langchain/angular";

@Component({
  standalone: true,
  template: `
    <div>
      @for (msg of stream.messages(); track msg.id ?? $index) {
        <div>
          <p>{{ str(msg.content) }}</p>

          @if (getBranchNav(msg, $index); as nav) {
            <button (click)="onPrev(nav)">Previous</button>
            <span>{{ nav.current + 1 }} / {{ nav.total }}</span>
            <button (click)="onNext(nav)">Next</button>
          }
        </div>
      }

      <button (click)="onSubmit()">Send</button>
    </div>
  `,
})
export class ChatComponent {
  stream = useStream({
    assistantId: "agent",
    apiUrl: "http://localhost:2024",
    fetchStateHistory: true,
  });

  str(v: unknown) {
    return typeof v === "string" ? v : JSON.stringify(v);
  }

  getBranchNav(msg: any, index: number) {
    const metadata = this.stream.getMessagesMetadata(msg, index);
    const options = metadata?.branchOptions;
    const branch = metadata?.branch;
    if (!options || !branch) return null;
    return {
      options,
      current: options.indexOf(branch),
      total: options.length,
    };
  }

  onPrev(nav: { options: string[]; current: number }) {
    const prev = nav.options[nav.current - 1];
    if (prev) this.stream.setBranch(prev);
  }

  onNext(nav: { options: string[]; current: number }) {
    const next = nav.options[nav.current + 1];
    if (next) this.stream.setBranch(next);
  }

  onSubmit() {
    void this.stream.submit({
      messages: [{ type: "human", content: "Hello" }],
    });
  }
}
```

## Server-Side Queuing

When `submit()` is called while a stream is already active, the SDK automatically creates the run on the server with `multitaskStrategy: "enqueue"`. The pending runs are tracked in `queue` and processed in order as each finishes:

```typescript
import { Component } from "@angular/core";
import { useStream } from "@langchain/angular";

@Component({
  standalone: true,
  template: `
    <div>
      @for (msg of stream.messages(); track msg.id ?? $index) {
        <div>{{ str(msg.content) }}</div>
      }

      @if (stream.queue.size() > 0) {
        <div>
          <p>{{ stream.queue.size() }} message(s) queued</p>
          <button (click)="onClearQueue()">Clear Queue</button>
        </div>
      }

      <button
        [disabled]="stream.isLoading()"
        (click)="onSubmit()"
      >
        Send
      </button>
      <button (click)="onNewThread()">New Thread</button>
    </div>
  `,
})
export class ChatComponent {
  stream = useStream({
    assistantId: "agent",
    apiUrl: "http://localhost:2024",
  });

  str(v: unknown) {
    return typeof v === "string" ? v : JSON.stringify(v);
  }

  onSubmit() {
    void this.stream.submit({
      messages: [{ type: "human", content: "Hello!" }],
    });
  }

  onClearQueue() {
    void this.stream.queue.clear();
  }

  onNewThread() {
    this.stream.switchThread(null);
  }
}
```

Switching threads via `switchThread()` cancels all pending runs and clears the queue.

## Custom Transport

Instead of connecting to a LangGraph API, you can provide your own streaming transport. Pass a `transport` object instead of `assistantId` to use a custom backend:

```typescript
import { Component } from "@angular/core";
import { useStream, FetchStreamTransport } from "@langchain/angular";
import type { BaseMessage } from "langchain";

@Component({
  standalone: true,
  template: `
    <div>
      @for (msg of stream.messages(); track msg.id ?? $index) {
        <div>
          <p>{{ str(msg.content) }}</p>
          @if (getStreamNode(msg, $index); as node) {
            <span>Node: {{ node }}</span>
          }
        </div>
      }

      <p>Current branch: {{ stream.branch() }}</p>

      <button
        [disabled]="stream.isLoading()"
        (click)="onSubmit()"
      >
        Send
      </button>
    </div>
  `,
})
export class ChatComponent {
  stream = useStream<{ messages: BaseMessage[] }>({
    transport: new FetchStreamTransport({
      url: "https://my-api.example.com/stream",
    }),
    threadId: null,
    onThreadId: (id) => console.log("Thread created:", id),
  });

  str(v: unknown) {
    return typeof v === "string" ? v : JSON.stringify(v);
  }

  getStreamNode(msg: any, index: number): string | null {
    const metadata = this.stream.getMessagesMetadata(msg, index);
    return (metadata?.streamMetadata as any)?.langgraph_node ?? null;
  }

  onSubmit() {
    void this.stream.submit({
      messages: [{ type: "human", content: "Hello!" }],
    });
  }
}
```

The custom transport interface returns the same properties as the standard `useStream` function, including `getMessagesMetadata`, `branch`, `setBranch`, `switchThread`, and all message/interrupt/subagent helpers. When using a custom transport, `getMessagesMetadata` returns stream metadata sent alongside messages during streaming; `branch` and `setBranch` provide local branch state management.

## Playground

For complete end-to-end examples with full agentic UIs, visit the [LangGraph Playground](https://github.com/langchain-ai/langgraphjs).

## License

MIT

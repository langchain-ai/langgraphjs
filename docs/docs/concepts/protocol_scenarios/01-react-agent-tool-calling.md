# Scenario 1: Simple ReAct Agent with Tool Calling

## Description

A single `createReactAgent` with tools (web search, calculator) handles a
multi-turn conversation. The user asks a question, the agent calls tools,
processes results, and responds. The frontend renders LLM tokens as they
stream, shows tool call progress, and displays the final answer.

This is the most common LangGraph use case and the baseline for protocol
parity — v2 must handle this as cleanly as v1.

## Agent Setup

```typescript
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { ChatOpenAI } from "@langchain/openai";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

const search = tool(
  async ({ query }) => {
    const results = await tavilySearch(query);
    return JSON.stringify(results.slice(0, 3));
  },
  {
    name: "web_search",
    description: "Search the web for current information",
    schema: z.object({ query: z.string() }),
  }
);

const calculator = tool(
  async ({ expression }) => String(eval(expression)),
  {
    name: "calculator",
    description: "Evaluate a math expression",
    schema: z.object({ expression: z.string() }),
  }
);

const agent = createReactAgent({
  llm: new ChatOpenAI({ model: "gpt-4o" }),
  tools: [search, calculator],
});
```

## v1: Current Approach

```typescript
// Backend: stream with messages + tools modes
for await (const chunk of await agent.stream(
  { messages: [{ role: "user", content: "What's the population of Tokyo times 3?" }] },
  { streamMode: ["messages", "tools"] }
)) {
  const [mode, data] = chunk;

  if (mode === "messages") {
    const [message, metadata] = data;
    process.stdout.write(message.content);
  }

  if (mode === "tools") {
    if (data.event === "on_tool_start") {
      console.log(`\nCalling tool: ${data.name}`);
    } else if (data.event === "on_tool_end") {
      console.log(`Tool result: ${JSON.stringify(data.output).slice(0, 100)}`);
    }
  }
}
```

```tsx
// Frontend (React): useStream with default transport
import { useStream } from "@langchain/react";

function Chat() {
  const thread = useStream<typeof agent>({
    apiUrl: "http://localhost:2024",
    assistantId: "agent",
  });

  return (
    <div>
      {thread.messages.map((msg) => (
        <Message key={msg.id} message={msg} />
      ))}
      {thread.isLoading && <Spinner />}
      <ChatInput onSubmit={(text) => thread.submit({ messages: [{ role: "user", content: text }] })} />
    </div>
  );
}
```

**What works**: Token streaming, tool call display, multi-turn conversation.

**What doesn't**: No way to subscribe to only specific event types. Client
receives all events and filters locally. For a simple single-agent case this
is fine — there's no performance concern.

## v2: Protocol Approach

### In-Process

```typescript
import { createSession } from "@langchain/langgraph/protocol";

const session = createSession(agent, {
  input: { messages: [{ role: "user", content: "What's the population of Tokyo times 3?" }] },
});

// Subscribe to messages and tools independently
const messages = session.subscribe("messages");
const tools = session.subscribe("tools");

// Consume concurrently
await Promise.all([
  (async () => {
    for await (const event of messages) {
      process.stdout.write(event.params.data.message.content);
    }
  })(),
  (async () => {
    for await (const event of tools) {
      const { data } = event.params;
      if (data.event === "on_tool_start") {
        console.log(`\nCalling tool: ${data.name}`);
      }
    }
  })(),
]);
```

### Frontend (React)

```tsx
import { useStream } from "@langchain/react";
import { ProtocolStreamTransport } from "@langchain/react/protocol";

function Chat() {
  const thread = useStream<typeof agent>({
    transport: new ProtocolStreamTransport({
      url: "ws://localhost:2024/v2/runs",
    }),
    assistantId: "agent",
  });

  // Rendering code is IDENTICAL to v1 — useStream's interface doesn't change.
  // The transport is the only difference.
  return (
    <div>
      {thread.messages.map((msg) => (
        <Message key={msg.id} message={msg} />
      ))}
      {thread.isLoading && <Spinner />}
      <ChatInput onSubmit={(text) => thread.submit({ messages: [{ role: "user", content: text }] })} />
    </div>
  );
}
```

## Protocol Analysis

### Can v1 handle this? **Yes.**

This is the core v1 use case. Token streaming, tool calls, and multi-turn
conversations work well today. There is no performance issue because a
single agent produces a manageable volume of events.

### What does v2 add?

For this simple case, the primary benefits are structural:

| Benefit | Detail |
|---------|--------|
| **Independent subscriptions** | Messages and tools are separate iterators instead of interleaved in one stream. Easier to route to different UI components. |
| **WebSocket transport** | Single persistent connection instead of new SSE connection per turn. Lower latency on turn boundaries. |
| **Protocol-level reconnection** | If the connection drops mid-stream, v2 can reconnect and replay missed events. v1 requires client-side retry logic. |
| **Usage tracking** | `session.subscribe("usage")` gives per-call token counts and costs — not available in v1 without custom instrumentation. |

### Verdict

v2 is a **drop-in replacement** for v1 in this scenario. The rendering code
is identical. The benefits are incremental (better transport, reconnection,
usage visibility) rather than transformational. This validates that v2
doesn't regress the most common use case.

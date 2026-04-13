# LangGraph JS/TS SDK

This repository contains the JS/TS SDK for interacting with the LangGraph REST API.

## Quick Start

To get started with the JS/TS SDK, [install the package](https://www.npmjs.com/package/@langchain/langgraph-sdk)

```bash
pnpm add @langchain/langgraph-sdk
```

You will need a running LangGraph API server. If you're running a server locally using `langgraph-cli`, SDK will automatically point at `http://localhost:8123`, otherwise
you would need to specify the server URL when creating a client.

```js
import { Client } from "@langchain/langgraph-sdk";

const client = new Client();

// List all assistants
const assistants = await client.assistants.search({
  metadata: null,
  offset: 0,
  limit: 10,
});

// We auto-create an assistant for each graph you register in config.
const agent = assistants[0];

// Start a new thread
const thread = await client.threads.create();

// Start a streaming run
const messages = [{ role: "human", content: "what's the weather in la" }];

const streamResponse = client.runs.stream(
  thread["thread_id"],
  agent["assistant_id"],
  {
    input: { messages },
  }
);

for await (const chunk of streamResponse) {
  console.log(chunk);
}
```

## Streaming Protocol Client

The SDK includes a built-in streaming protocol client (`client.stream`) that provides session-based streaming with subscriptions, message assembly, and capability-gated modules over SSE or WebSocket transports.

### Using via the main Client

The `stream` property on `Client` is pre-configured with the same API URL, authentication, and headers:

```js
import { Client } from "@langchain/langgraph-sdk";

const client = new Client();
const session = await client.stream.open({
  protocolVersion: "0.3.0",
  target: { kind: "agent", id: "my-agent" },
});

// Subscribe to messages
const messages = await session.subscribeMessages();
await session.run.input({
  input: { messages: [{ role: "user", content: "Hello" }] },
});

for await (const message of messages) {
  console.log(message.blocks);
}

await session.close();
```

### Standalone usage with custom transport

You can use `ProtocolClient` directly with any `TransportAdapter`:

```js
import {
  ProtocolClient,
  ProtocolSseTransportAdapter,
} from "@langchain/langgraph-sdk";

const client = new ProtocolClient(
  () =>
    new ProtocolSseTransportAdapter({
      apiUrl: "http://localhost:8123",
    })
);

const session = await client.open({ protocolVersion: "0.3.0" });
```

### Key concepts

- **`ProtocolClient`** — Entry point for opening sessions over a transport.
- **`Session`** — High-level wrapper that exposes command modules (`run`, `agent`, `resource`, `sandbox`, `input`, `state`, `usage`), subscription management, and event replay.
- **`TransportAdapter`** — Interface implemented by `ProtocolSseTransportAdapter` (HTTP+SSE) and `ProtocolWebSocketTransportAdapter` (WebSocket).
- **`EventBuffer`** — Bounded in-memory buffer for replaying recent events to new subscriptions.
- **`MessageAssembler`** — Incrementally assembles streamed message events into complete `AssembledMessage` objects.

### Architecture

The client code is organized into sub-client modules under `src/client/`:

| Path | Module |
| ---- | ------ |
| `client/assistants/` | `AssistantsClient` |
| `client/threads/` | `ThreadsClient` |
| `client/runs/` | `RunsClient` |
| `client/crons/` | `CronsClient` |
| `client/store/` | `StoreClient` |
| `client/stream/` | `ProtocolClient`, `Session`, transports |
| `client/base.ts` | `BaseClient`, shared config & helpers |
| `client/index.ts` | Main `Client` class & re-exports |

## Change Log

The change log for new versions can be found in [CHANGELOG.md](https://github.com/langchain-ai/langgraphjs/blob/main/libs/sdk/CHANGELOG.md).

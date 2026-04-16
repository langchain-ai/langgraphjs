# Durable Objects Checkpointer — WebSocket Chat Example

A Cloudflare Worker that demonstrates the `DurableObjectSqliteSaver` checkpointer with a WebSocket chat API supporting conversation forking.

## Setup

```bash
cd examples/checkpoint-durable-objects
pnpm install
```

## Run locally

```bash
pnpm dev
```

## Test

```bash
pnpm test
```

## WebSocket API

Connect to `ws://localhost:8787/thread/:threadId`

### Send a message

```json
{ "type": "message", "content": "hello" }
→ { "type": "response", "userMessage": {...}, "assistantMessage": {...}, "messageCount": 2, "checkpointId": "..." }
```

### Fork (rewind to a checkpoint)

```json
{ "type": "fork", "checkpointId": "..." }
→ { "type": "forked", "checkpointId": "...", "messageCount": N, "messages": [...] }
```

### Get current messages

```json
{ "type": "get_messages" }
→ { "type": "messages", "messages": [...] }
```

### Get checkpoint history

```json
{ "type": "get_history" }
→ { "type": "history", "history": [{ "checkpointId": "...", "step": N, "messageCount": N, "ts": "..." }, ...] }
```

## Architecture

Each thread gets its own Durable Object (keyed by thread ID). The DO owns a `DurableObjectSqliteSaver` backed by `ctx.storage`. Messages are stored individually in the `channel_items` table — never duplicated across checkpoints. WebSocket connections use the Hibernation API so the DO can sleep between messages.

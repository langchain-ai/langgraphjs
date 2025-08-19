# @langchain/langgraph-checkpoint-redis

Redis checkpoint and store implementation for LangGraph.

## Overview

This package provides Redis-based implementations for:

1. **Checkpoint Savers**: Store and manage LangGraph checkpoints using Redis
    - **RedisSaver**: Standard checkpoint saver that maintains full checkpoint history
    - **ShallowRedisSaver**: Memory-optimized saver that only keeps the latest checkpoint per thread
2. **RedisStore**: Redis-backed key-value store with optional vector search capabilities

## Installation

```bash
npm install @langchain/langgraph-checkpoint-redis
```

## Dependencies

### Redis Requirements

This library requires Redis with the following modules:

- **RedisJSON** - For storing and manipulating JSON data
- **RediSearch** - For search and indexing capabilities

#### Redis 8.0+

If you're using Redis 8.0 or higher, both RedisJSON and RediSearch modules are included by default.

#### Redis < 8.0

For Redis versions lower than 8.0, you'll need to:

- Use [Redis Stack](https://redis.io/docs/stack/), which bundles Redis with these modules
- Or install the modules separately in your Redis instance

## Usage

### Standard Checkpoint Saver

```typescript
import {RedisSaver} from "@langchain/langgraph-checkpoint-redis";

const checkpointer = await RedisSaver.fromUrl(
    "redis://localhost:6379",
    {
        defaultTTL: 60, // TTL in minutes
        refreshOnRead: true
    }
);

// Indices are automatically created by fromUrl()

// Use with your graph
const config = {configurable: {thread_id: "1"}};

// Metadata must include required fields
const metadata = {
    source: "update",  // "update" | "input" | "loop" | "fork"
    step: 0,
    parents: {}
};

await checkpointer.put(config, checkpoint, metadata, {});
const loaded = await checkpointer.get(config);
```

### Shallow Checkpoint Saver

The `ShallowRedisSaver` is a memory-optimized variant that only keeps the latest checkpoint per thread:

```typescript
import {ShallowRedisSaver} from "@langchain/langgraph-checkpoint-redis";

// Create a shallow saver that only keeps the latest checkpoint
const shallowSaver = await ShallowRedisSaver.fromUrl("redis://localhost:6379");

// Use it the same way as RedisSaver
const config = {
    configurable: {
        thread_id: "my-thread",
        checkpoint_ns: "my-namespace"
    }
};

const metadata = {
    source: "update",
    step: 0,
    parents: {}
};

await shallowSaver.put(config, checkpoint, metadata, versions);

// Only the latest checkpoint is kept - older ones are automatically cleaned up
const latest = await shallowSaver.getTuple(config);
```

Key differences from RedisSaver:

- **Storage**: Only keeps the latest checkpoint per thread (no history)
- **Performance**: Reduced storage usage and faster operations
- **Inline storage**: Channel values are stored inline (no separate blob storage)
- **Automatic cleanup**: Old checkpoints and writes are automatically removed

### RedisStore

The `RedisStore` provides a key-value store with optional vector search capabilities:

```typescript
import {RedisStore} from "@langchain/langgraph-checkpoint-redis";

// Basic key-value store
const store = await RedisStore.fromConnString("redis://localhost:6379");

// Store with vector search
const vectorStore = await RedisStore.fromConnString("redis://localhost:6379", {
    index: {
        dims: 1536,  // Embedding dimensions
        embed: embeddings,  // Your embeddings instance
        distanceType: "cosine",  // or "l2", "ip"
        fields: ["text"],  // Fields to embed
    },
    ttl: {
        defaultTTL: 60,  // TTL in minutes
        refreshOnRead: true,
    }
});

// Put and get items
await store.put(["namespace", "nested"], "key1", {text: "Hello world"});
const item = await store.get(["namespace", "nested"], "key1");

// Search with namespace filtering
const results = await store.search(["namespace"], {
    filter: {category: "docs"},
    limit: 10,
});

// Vector search
const semanticResults = await vectorStore.search(["namespace"], {
    query: "semantic search query",
    filter: {type: "article"},
    limit: 5,
});

// Batch operations
const ops = [
    {type: "get", namespace: ["ns"], key: "key1"},
    {type: "put", namespace: ["ns"], key: "key2", value: {data: "value"}},
    {type: "search", namespacePrefix: ["ns"], limit: 10},
    {type: "list_namespaces", matchConditions: [{matchType: "prefix", path: ["ns"]}], limit: 10},
];
const results = await store.batch(ops);
```

## TTL Support

Both checkpoint savers and stores support Time-To-Live (TTL) functionality:

```typescript
const ttlConfig = {
    defaultTTL: 60,  // Default TTL in minutes
    refreshOnRead: true,  // Refresh TTL when items are read
};

const checkpointer = await RedisSaver.fromUrl("redis://localhost:6379", ttlConfig);
```

## Development

### Running Tests

```bash
# Run tests (uses TestContainers automatically)
yarn test

# Run tests in watch mode
yarn test:watch

# Run integration tests
yarn test:int
```

## License

MIT
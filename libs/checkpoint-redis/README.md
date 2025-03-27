# @langchain/langgraph-checkpoint-redis

Implementation of a [LangGraph.js](https://github.com/langchain-ai/langgraphjs) CheckpointSaver that uses Redis.

## Usage

```ts
import { RedisSaver } from "@langchain/langgraph-checkpoint-redis";
import { createClient } from "redis";

const writeConfig = {
  configurable: {
    thread_id: "1",
    checkpoint_ns: ""
  }
};
const readConfig = {
  configurable: {
    thread_id: "1"
  }
};

// Create a Redis client
const client = createClient({
  url: "redis://localhost:6379"
});

// Create a Redis checkpoint saver with options
const checkpointer = new RedisSaver(client, {
  isCluster: false, // use true for Redis Cluster
  prefix: "langgraph", // prefix for Redis keys
  ttl: 3600 // expiration time in seconds, 0 for no expiration
});

const checkpoint = {
  v: 1,
  ts: "2024-07-31T20:14:19.804150+00:00",
  id: "1ef4f797-8335-6428-8001-8a1503f9b875",
  channel_values: {
    my_key: "meow",
    node: "node"
  },
  channel_versions: {
    __start__: 2,
    my_key: 3,
    "start:node": 3,
    node: 3
  },
  versions_seen: {
    __input__: {},
    __start__: {
      __start__: 1
    },
    node: {
      "start:node": 2
    }
  },
  pending_sends: [],
}

// Store checkpoint
await checkpointer.put(writeConfig, checkpoint, {});

// Load checkpoint
await checkpointer.get(readConfig);

// List checkpoints
for await (const checkpoint of checkpointer.list(readConfig)) {
  console.log(checkpoint);
}

// Read thread messages
const messages = await checkpointer.read("1");
console.log(messages); // Array of { role: 'user' | 'assistant', content: string }

// Clear all checkpoints for a thread
await checkpointer.clear("1");
```

## Redis Cluster Support

The RedisSaver supports Redis Cluster deployments. When using Redis Cluster, set the `isCluster` option to `true`:

```ts
import { RedisSaver } from "@langchain/langgraph-checkpoint-redis";
import { createCluster } from "redis";

// Create a Redis cluster client
const clusterClient = createCluster({
  rootNodes: [
    {
      url: 'redis://localhost:7000'
    },
    {
      url: 'redis://localhost:7001'
    },
    {
      url: 'redis://localhost:7002'
    }
  ]
});

// Create a Redis checkpoint saver with cluster support
const checkpointer = new RedisSaver(clusterClient, {
  isCluster: true,
  prefix: "langgraph",
  ttl: 3600
});

// Ensure the Redis cluster client is connected
await clusterClient.connect();
```

## Testing

Spin up a test Redis server:

```bash
docker run --name redis-test -p 6379:6379 -d redis
```

Then use the following code to initialize your checkpointer:

```ts
import { createClient } from "redis";
import { RedisSaver } from "@langchain/langgraph-checkpoint-redis";

const client = createClient({
  url: "redis://localhost:6379"
});

const testCheckpointer = new RedisSaver(client, {
  isCluster: false,
  prefix: "test",
  ttl: 0
});

```

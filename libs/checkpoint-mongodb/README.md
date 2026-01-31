# @langchain/langgraph-checkpoint-mongodb

Implementation of a [LangGraph.js](https://github.com/langchain-ai/langgraphjs) CheckpointSaver that uses a MongoDB instance.

## Usage

```ts
import { MongoClient } from "mongodb";
import { MongoDBSaver } from "@langchain/langgraph-checkpoint-mongodb";

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


const client = new MongoClient(process.env.MONGODB_URL);

const checkpointer = new MongoDBSaver({ client });
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

// store checkpoint
await checkpointer.put(writeConfig, checkpoint, {}, {});

// load checkpoint
await checkpointer.get(readConfig);

// list checkpoints
for await (const checkpoint of checkpointer.list(readConfig)) {
  console.log(checkpoint);
}

await client.close();
```

## TTL (Time-To-Live) Support

Automatically expire old checkpoints using MongoDB's TTL indexes:

```ts
import { MongoClient } from "mongodb";
import { MongoDBSaver } from "@langchain/langgraph-checkpoint-mongodb";

const client = new MongoClient(process.env.MONGODB_URL);

// Create checkpointer with 1-hour TTL (in seconds)
const checkpointer = new MongoDBSaver({
  client,
  ttl: 3600,
});

// Create TTL indexes (call during deployment/startup)
await checkpointer.setup();
```

When TTL is enabled:
- An `upserted_at` timestamp is added to each document on every write
- MongoDB automatically deletes documents after the TTL expires
- Each update resets the expiration timer

The `setup()` method creates the required TTL indexes. Call it during application startup or deployment. It is idempotent and handles concurrent calls safely.

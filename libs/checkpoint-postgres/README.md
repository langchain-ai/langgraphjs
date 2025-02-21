# @langchain/langgraph-checkpoint-postgres

Implementation of a [LangGraph.js](https://github.com/langchain-ai/langgraphjs) CheckpointSaver that uses a Postgres DB.

## Usage

```ts
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";

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

// you can optionally pass a configuration object as the second parameter
const checkpointer = PostgresSaver.fromConnString("postgresql://...", {
  schema: "schema_name" // defaults to "public"
});

// You must call .setup() the first time you use the checkpointer:
await checkpointer.setup();

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
```

## Testing

Spin up testing PostgreSQL

```bash
docker-compose up -d && docker-compose logs -f
```

Then use the following connection string to initialize your checkpointer:

```ts
const testCheckpointer = PostgresSaver.fromConnString(
  "postgresql://user:password@localhost:5434/testdb"
);
```

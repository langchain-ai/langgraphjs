# @langchain/langgraph-checkpoint-filesystem

Implementation of a [LangGraph.js](https://github.com/langchain-ai/langgraphjs) CheckpointSaver that based on file system. For the implementation, refer to [MemorySaver](https://github.com/postbird/langgraphjs/blob/main/libs/checkpoint/src/memory.ts).

When is it appropriate to use this package?

1. If you want to learn more about the implementation of Checkpoint in Langgraph.js and want to know what the stored data structure is, so as to customize and implement a Checkpoint that fits your own cloud service.

2. If you want to persistently store thread data, but don't want to introduce more external dependencies (such as PostgreSQL).

:::info

For Node.js environment only, require file I/O permission.

:::

## Usage

```ts
import { FileCheckPointSaver } from "@langchain/langgraph-checkpoint-filesystem";

const writeConfig = {
  configurable: {
    thread_id: "1",
    checkpoint_ns: "",
  },
};

const readConfig = {
  configurable: {
    thread_id: "1",
  },
};

const checkpointer = new FileCheckPointSaver({
  base: "./checkpoints",
  fileExtension: ".json",
});

const checkpoint = {
  v: 1,
  ts: "2024-07-31T20:14:19.804150+00:00",
  id: "1ef4f797-8335-6428-8001-8a1503f9b875",
  channel_values: {
    my_key: "meow",
    node: "node",
  },
  channel_versions: {
    __start__: 2,
    my_key: 3,
    "start:node": 3,
    node: 3,
  },
  versions_seen: {
    __input__: {},
    __start__: {
      __start__: 1,
    },
    node: {
      "start:node": 2,
    },
  },
  pending_sends: [],
};

// store checkpoint
await checkpointer.put(writeConfig, checkpoint, {}, {});

// load checkpoint
await checkpointer.get(readConfig);

// list checkpoints
for await (const checkpoint of checkpointer.list(readConfig)) {
  console.log(checkpoint);
}
```

## Check the stored data

For the current implementation, all data will be stored in its original structured format, not binary like other implementation packages (for example, sqllite, mongodb)

You can check the dir which is provided from the param `config.base`, each thread_id will be stored in a standalone dir.

The structure of the storage dir like below:

```

checkpoints/ (provided from `config.base`)
├── {thread_id}/
│ ├── storage.json
│ └── writes.json
└── ...

```

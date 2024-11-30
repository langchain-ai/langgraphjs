# @langchain/langgraph-checkpoint-firebase

Implementation of a [LangGraph.js](https://github.com/langchain-ai/langgraphjs) CheckpointSaver that uses a FireBase instance.

The `FirebaseSaver` class is an implementation of the `BaseCheckpointSaver` interface that uses Firebase Realtime Database for persistence. It is part of the `@langchain/langgraph-checkpoint` library and provides scalable, real-time management of checkpoints in LangGraph.js.

---

## Features

- **Firebase Persistence**: Leverages Firebase's real-time capabilities to store checkpoints and metadata.
- **Thread Management**: Isolates states using thread-based checkpointing for multi-tenant or parallel use cases.
- **Pending Writes**: Handles intermediate writes for partially executed graph nodes.
- **Real-Time Updates**: Takes advantage of Firebase's dynamic data updates for live applications.

---

## Installation

### Prerequisites
- Firebase Realtime Database instance
- Node.js with TypeScript

### Install Dependencies
```bash
npm install @langchain/langgraph-checkpoint firebase

### Usage

```ts
import { initializeApp } from "firebase/app";
import { getDatabase } from "firebase/database";
import { FirebaseSaver } from "@langchain/langgraph-checkpoint-firebase";

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

const firebaseConfig = {
      apiKey: "REPLACE-WITH-YOUR-API-KEY",
      authDomain: "REPLACE-WITH-YOUR-localhost",
      projectId: "REPLACE-WITH-YOUR-TEST-PROJECT",
      databaseURL: process.env.FIREBASEURL || "http://localhost:9000", // Use emulator URL
    };
    process.env.FIREBASE_URL = process.env.FIREBASEURL || "http://localhost:9000"
    const app = initializeApp(firebaseConfig);

    database = getDatabase(app);

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
    start:node: 3,
    node: 3
  },
  versions_seen: {
    __input__: {},
    __start__: {
      __start__: 1
    },
    node: {
      start:node: 2
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


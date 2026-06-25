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

## Usage with existing connection pool

```ts
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import pg from "pg";

// You can use any existing postgres connection pool
// we create a new pool here for the sake of the example
const pool = new pg.Pool({
  connectionString: "postgresql://..."
});

const checkpointer = new PostgresSaver(pool, undefined, {
  schema: "schema_name"
});

await checkpointer.setup();

// ...
```

## Edge & serverless runtimes (Cloudflare Workers, etc.)

`PostgresSaver` uses [node-postgres (`pg`)](https://node-postgres.com/) under the hood, which opens a raw TCP/TLS connection via Node's `net`/`tls` modules. Some serverless/edge runtimes, most notably **Cloudflare Workers**, do not support raw outbound TCP connections from arbitrary code, so a direct connection (including the initial `await checkpointer.setup()`) will hang. This is the root cause for issues where the runtime reports that the Worker "had hung and would never generate a response".

This is a database-driver/runtime limitation, **not** a persistence-flush problem. LangGraph awaits all pending checkpoint writes before `invoke()`/`stream()` resolves (see the [base checkpoint package README](../checkpoint/README.md#when-are-checkpoints-persisted)), so as long as you `await` the run you do not need `ctx.waitUntil()` to keep the runtime alive for persistence.

To use Postgres checkpointing from Cloudflare Workers, route the connection through [Cloudflare Hyperdrive](https://developers.cloudflare.com/hyperdrive/), which exposes a `pg`-compatible connection string:

```ts
// wrangler.toml / wrangler.jsonc must enable `nodejs_compat` and bind a Hyperdrive instance:
//   compatibility_flags = ["nodejs_compat"]
//   [[hyperdrive]]
//   binding = "HYPERDRIVE"
//   id = "<your-hyperdrive-id>"

import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const checkpointer = PostgresSaver.fromConnString(
      env.HYPERDRIVE.connectionString
    );
    // ... compile and `await graph.invoke(...)` here ...
    // Persistence is complete once `invoke`/`stream` resolves.
    return new Response("ok");
  },
};
```

Alternatively, implement a thin `BaseCheckpointSaver` on top of an HTTP/WebSocket Postgres driver such as [`@neondatabase/serverless`](https://github.com/neondatabase/serverless) that is designed for edge runtimes.

> Note: standard Node.js, Deno, and Bun deployments are unaffected — `PostgresSaver` works there out of the box.

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

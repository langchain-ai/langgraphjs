# LangGraph PostgreSQL Store

A PostgreSQL implementation of the `BaseStore` interface from `@langchain/langgraph`. This store allows you to persist your application data in a PostgreSQL database for use with LangGraph.js.

## Installation

```bash
npm install @langchain/langgraph-store-postgres
```

## Requirements

- Node.js >= 18
- PostgreSQL server (version 10 or later recommended)

## Usage

### Basic Usage

```typescript
import { PostgresStore } from "@langchain/langgraph-store-postgres";

// Create a new store
const store = new PostgresStore({
  connectionOptions: {
    host: "localhost",
    port: 5432,
    database: "mydb",
    user: "postgres",
    password: "password",
    ssl: false
  },
  schema: "langgraph_store" // Optional, defaults to "langgraph_store"
});

// Initialize the store (creates tables if they don't exist)
await store.start();

// Store values
await store.mset([
  ["key1", { name: "Alice", age: 30 }],
  ["key2", { name: "Bob", age: 25 }]
]);

// Retrieve values
const values = await store.mget(["key1", "key2", "nonexistent"]);
console.log(values); 
// [{ name: "Alice", age: 30 }, { name: "Bob", age: 25 }, undefined]

// Delete values
await store.mdelete(["key1"]);

// Iterate through all keys
for await (const key of store.yieldKeys()) {
  console.log(key);
}

// Iterate through keys with a specific prefix
for await (const key of store.yieldKeys("user_")) {
  console.log(key);
}

// Cleanup resources when done
await store.stop();
```

### Using with LangGraph

You can use the PostgreSQL store with LangGraph.js to persist state across threads:

```typescript
import { PostgresStore } from "@langchain/langgraph-store-postgres";
import { StateGraph, END } from "@langchain/langgraph";

// Create a store
const store = new PostgresStore({
  connectionOptions: {
    connectionString: "postgresql://postgres:postgres@localhost:5432/langchain"
  }
});

// Initialize the store
await store.start();

// Create a graph with the store
const graph = new StateGraph({
  channels: { value: { value: 0 } },
  store
})
  .addNode("increment", (state) => ({ value: state.value + 1 }))
  .addEdge("increment", END);

// Compile the graph with the store
const executor = graph.compile();

// Run the graph - state will be persisted in PostgreSQL
const result = await executor.invoke({ threadId: "my-unique-thread-id", value: 5 });
console.log(result); // { value: 6 }
```

## Configuration Options

The PostgresStore constructor accepts the following options:

| Option | Type | Description | Default |
|--------|------|-------------|---------|
| `connectionOptions` | `string \| object` | PostgreSQL connection parameters - can be a connection string or a configuration object | Required |
| `schema` | `string` | Schema name to use for tables | `"langgraph_store"` |
| `ttl` | `number` | TTL (Time To Live) in seconds for stored values | `0` (no expiration) |
| `ensureTables` | `boolean` | Whether to automatically create tables if they don't exist | `true` |
| `maxRetries` | `number` | Number of retries for database operations | `3` |
| `serializeJson` | `boolean` | Whether to serialize values as JSON | `true` |

### Connection Options

You can provide connection options as an object:

```typescript
const store = new PostgresStore({
  connectionOptions: {
    host: "localhost",
    port: 5432,
    database: "mydb",
    user: "postgres",
    password: "password",
    ssl: {
      rejectUnauthorized: false
    }
  }
});
```

Or as a connection string:

```typescript
const store = new PostgresStore({
  connectionOptions: "postgresql://username:password@localhost:5432/database"
});
```

## Advanced Features

### Namespace Support

You can use namespaces to organize your data:

```typescript
// Set a namespace for all operations
store.setNamespace("user_data");

// Store values in that namespace
await store.mset([["user1", { name: "Alice" }]]);

// Retrieve values from that namespace
const users = await store.mget(["user1"]);

// Change namespace
store.setNamespace("app_settings");

// Store values in the new namespace
await store.mset([["theme", "dark"]]);
```

### TTL (Time To Live)

You can set a TTL to automatically expire entries:

```typescript
const cacheStore = new PostgresStore({
  connectionOptions: "postgresql://postgres:postgres@localhost:5432/langchain",
  ttl: 3600 // 1 hour in seconds
});

// Values will be automatically deleted after 1 hour
await cacheStore.mset([["temp_data", { some: "value" }]]);
```

## License

MIT

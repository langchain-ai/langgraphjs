---
"@langchain/langgraph-checkpoint-postgres": minor
---

Add support for passing a preconfigured `pg.Pool` to `PostgresStore`, enabling a single connection pool to be shared between `PostgresSaver` and `PostgresStore` for better resource management.

**What changed:**

- `PostgresStoreConfig` now accepts an optional `pool` field for passing a preconfigured `pg.Pool` instance directly. If both `pool` and `connectionOptions` are provided, `pool` takes precedence.
- Added a new `PostgresStore.fromPool(pool, options?)` static factory method for convenience.
- When an external pool is provided, `store.stop()` will no longer close the pool — the caller retains ownership of the pool lifecycle.

**Why:**

Previously, `PostgresStore` always created its own internal pool, which meant a server using both a `PostgresSaver` and a `PostgresStore` would hold two separate connection pools. This made it impossible to share connections across use cases and led to unnecessary resource consumption.

**How to update your code:**

```typescript
import pg from "pg";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { PostgresStore } from "@langchain/langgraph-checkpoint-postgres/store";

// Create a single shared pool
const pool = new pg.Pool({ connectionString: "postgresql://..." });

// Share it between the saver and the store
const saver = new PostgresSaver(pool);
const store = PostgresStore.fromPool(pool);

// Or pass it via the constructor
const store2 = new PostgresStore({ pool });

await saver.setup();
await store.setup();
```

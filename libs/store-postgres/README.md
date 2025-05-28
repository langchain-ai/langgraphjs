# @langchain/langgraph-store-postgres

PostgreSQL implementation of the LangGraph Store interface for persistent key-value storage with hierarchical namespaces.

## Features

- **Persistent Storage**: Data is stored in PostgreSQL and survives application restarts
- **Hierarchical Namespaces**: Organize data with nested namespace structures like `["users", "profiles"]`
- **Full-Text Search**: Search through stored values using PostgreSQL's text search capabilities
- **JSON Filtering**: Filter results using JSON path queries and operators
- **Batch Operations**: Execute multiple operations efficiently in a single call
- **ACID Transactions**: Benefit from PostgreSQL's transaction guarantees
- **Automatic Schema Management**: Tables and indexes are created automatically

## Installation

```bash
npm install @langchain/langgraph-store-postgres
# or
yarn add @langchain/langgraph-store-postgres
```

## Prerequisites

- PostgreSQL 12 or higher
- Node.js 18 or higher

## Quick Start

```typescript
import { PostgresStore } from "@langchain/langgraph-store-postgres";

// Create store instance
const store = new PostgresStore({
  connectionOptions: "postgresql://user:password@localhost:5432/database"
});

// Initialize (creates tables if needed)
await store.setup();

// Store data
await store.put(["users"], "user123", {
  name: "John Doe",
  email: "john@example.com"
});

// Retrieve data
const user = await store.get(["users"], "user123");
console.log(user?.value); // { name: "John Doe", email: "john@example.com" }

// Clean up
await store.end();
```

## Configuration

### Connection Options

You can configure the PostgreSQL connection using either a connection string or a configuration object:

```typescript
// Using connection string
const store = new PostgresStore({
  connectionOptions: "postgresql://user:password@localhost:5432/database"
});

// Using configuration object
const store = new PostgresStore({
  connectionOptions: {
    host: "localhost",
    port: 5432,
    database: "myapp",
    user: "postgres",
    password: "password",
    ssl: true,
    max: 20, // Maximum number of connections in pool
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
  }
});
```

### Schema Configuration

```typescript
const store = new PostgresStore({
  connectionOptions: "postgresql://...",
  schema: "langgraph_store", // Custom schema name (default: "public")
  ensureTables: true, // Auto-create tables (default: true)
});
```

## Usage Examples

### Basic Operations

```typescript
// Store data with hierarchical namespaces
await store.put(["documents", "user123"], "doc1", {
  title: "My Document",
  content: "Document content here",
  tags: ["important", "draft"]
});

// Retrieve data
const doc = await store.get(["documents", "user123"], "doc1");

// Update data (same as put)
await store.put(["documents", "user123"], "doc1", {
  title: "My Updated Document",
  content: "Updated content",
  tags: ["important", "final"]
});

// Delete data
await store.delete(["documents", "user123"], "doc1");
```

### Search and Filtering

```typescript
// Store multiple documents
await store.put(["docs"], "doc1", { type: "article", status: "published" });
await store.put(["docs"], "doc2", { type: "article", status: "draft" });
await store.put(["docs"], "doc3", { type: "tutorial", status: "published" });

// Filter by exact match
const articles = await store.search(["docs"], {
  filter: { type: "article" }
});

// Filter by nested properties
const published = await store.search(["docs"], {
  filter: { status: "published" }
});

// Full-text search
const results = await store.search(["docs"], {
  query: "tutorial programming"
});

// Combined filtering and search
const publishedArticles = await store.search(["docs"], {
  filter: { type: "article", status: "published" },
  query: "javascript",
  limit: 10,
  offset: 0
});
```

### Namespace Management

```typescript
// Store data in different namespaces
await store.put(["users", "profiles"], "user1", { name: "Alice" });
await store.put(["users", "settings"], "user1", { theme: "dark" });
await store.put(["docs", "v1"], "doc1", { title: "Doc 1" });
await store.put(["docs", "v2"], "doc1", { title: "Doc 1 v2" });

// List all namespaces
const allNamespaces = await store.listNamespaces();
// Returns: [["users", "profiles"], ["users", "settings"], ["docs", "v1"], ["docs", "v2"]]

// List namespaces with prefix filter
const userNamespaces = await store.listNamespaces({
  prefix: ["users"]
});
// Returns: [["users", "profiles"], ["users", "settings"]]

// List with depth limit
const topLevel = await store.listNamespaces({
  maxDepth: 1
});
// Returns: [["users"], ["docs"]]
```

### Batch Operations

```typescript
// Execute multiple operations in a single call
const results = await store.batch([
  // Put operations
  { namespace: ["batch"], key: "item1", value: { data: "first" } },
  { namespace: ["batch"], key: "item2", value: { data: "second" } },
  
  // Get operations
  { namespace: ["batch"], key: "item1" },
  
  // Search operations
  { 
    namespacePrefix: ["batch"], 
    filter: { data: "first" },
    limit: 10,
    offset: 0
  }
]);

// Results array corresponds to operations array
console.log(results[0]); // undefined (put result)
console.log(results[1]); // undefined (put result)  
console.log(results[2]); // Item object (get result)
console.log(results[3]); // Array of items (search result)
```

## Advanced Features

### TTL (Time To Live) Support

The PostgreSQL store supports automatic expiration of items using TTL:

```typescript
import { PostgresStore } from "@langchain/langgraph-store-postgres";

const store = new PostgresStore({
  connectionOptions: "postgresql://user:password@localhost:5432/database",
  ttl: {
    defaultTtl: 60, // Default TTL in minutes
    refreshOnRead: true, // Refresh TTL when items are read
    sweepIntervalMinutes: 30, // Run cleanup every 30 minutes
  },
});

await store.setup();

// Put item with default TTL
await store.putAdvanced(["cache"], "temp-data", { value: "expires in 60 minutes" });

// Put item with custom TTL
await store.putAdvanced(
  ["cache"], 
  "short-lived", 
  { value: "expires in 5 minutes" },
  { ttl: 5 }
);

// Manually sweep expired items
const expiredCount = await store.sweepExpiredItems();
console.log(`Removed ${expiredCount} expired items`);
```

### Advanced Filtering

Use MongoDB-style operators for complex queries:

```typescript
// Comparison operators
const results = await store.searchAdvanced(["products"], {
  filter: {
    price: { $gt: 100, $lt: 500 }, // Price between 100 and 500
    category: { $in: ["electronics", "books"] }, // Category is electronics or books
    inStock: { $exists: true }, // Has inStock field
    rating: { $gte: 4.0 }, // Rating >= 4.0
  },
});

// Complex nested queries
const complexResults = await store.searchAdvanced(["users"], {
  filter: {
    "profile.age": { $gte: 18 }, // Nested field access
    "preferences.notifications": { $ne: false }, // Not equal to false
    tags: { $nin: ["spam", "blocked"] }, // Not in array
  },
});
```

#### Supported Operators

- `$eq`: Equal to
- `$ne`: Not equal to
- `$gt`: Greater than
- `$gte`: Greater than or equal to
- `$lt`: Less than
- `$lte`: Less than or equal to
- `$in`: Value is in array
- `$nin`: Value is not in array
- `$exists`: Field exists (true) or doesn't exist (false)

### Enhanced Search with Similarity Scoring

Perform full-text search with relevance scoring:

```typescript
const searchResults = await store.searchAdvanced(["documents"], {
  query: "machine learning algorithms", // Full-text search query
  filter: {
    category: "research",
    published: { $gte: "2023-01-01" },
  },
  limit: 20,
  offset: 0,
  refreshTtl: true, // Refresh TTL for returned items
});

// Results include similarity scores
searchResults.forEach(item => {
  console.log(`${item.key}: score ${item.score}`);
});
```

### Store Statistics

Get insights about your store:

```typescript
const stats = await store.getStats();
console.log({
  totalItems: stats.totalItems,
  expiredItems: stats.expiredItems,
  namespaceCount: stats.namespaceCount,
  oldestItem: stats.oldestItem,
  newestItem: stats.newestItem,
});
```

## Vector Search Capabilities

The PostgreSQL store supports sophisticated vector similarity search using the pgvector extension, matching the capabilities of the Python implementation with advanced HNSW (Hierarchical Navigable Small World) indexes.

### Configuration

To enable vector search, provide an `IndexConfig` when creating the store:

```typescript
import { PostgresStore } from "@langchain/langgraph-store-postgres";

const store = new PostgresStore({
  connectionOptions: "postgresql://user:password@localhost:5432/database",
  index: {
    dims: 1536, // Embedding dimensions
    embed: embedFunction, // Embedding function
    fields: ["content", "title"], // Fields to embed
    indexType: 'hnsw', // Use HNSW for best performance
    distanceMetric: 'cosine',
    hnsw: {
      m: 32,              // Higher connectivity for better recall
      efConstruction: 400, // Higher construction quality  
      ef: 80              // Search quality parameter
    }
  }
});

await store.setup();
```

### Index Types

The store supports two vector index types:

#### HNSW (Recommended)
- **Best for**: Most use cases, especially high-dimensional data
- **Advantages**: Better recall/precision, faster queries, consistent performance
- **Configuration**: `m`, `efConstruction`, `ef` parameters

```typescript
index: {
  dims: 384,
  embed: embeddings,
  indexType: 'hnsw',
  hnsw: {
    m: 16,              // Connections per node (default: 16)
    efConstruction: 200, // Build quality (default: 200)
    ef: 40              // Search quality (default: 40)
  }
}
```

#### IVFFlat
- **Best for**: Large datasets where build time is less critical
- **Advantages**: Good for very large datasets, lower memory usage during build
- **Configuration**: `lists`, `probes` parameters

```typescript
index: {
  dims: 384,
  embed: embeddings,
  indexType: 'ivfflat',
  ivfflat: {
    lists: 100,  // Number of clusters (default: 100)
    probes: 1    // Search probes (default: 1)
  }
}
```

### Embedding Functions

The store supports multiple types of embedding functions:

#### LangChain Embeddings Interface

```typescript
import { OpenAIEmbeddings } from "@langchain/openai";

const embeddings = new OpenAIEmbeddings({
  modelName: "text-embedding-3-small"
});

const store = new PostgresStore({
  connectionOptions: connectionString,
  index: {
    dims: 1536,
    embed: embeddings
  }
});
```

#### Custom Embedding Function

```typescript
async function customEmbedFunction(texts: string[]): Promise<number[][]> {
  // Your custom embedding logic
  return texts.map(text => generateEmbedding(text));
}

const store = new PostgresStore({
  connectionOptions: connectionString,
  index: {
    dims: 384,
    embed: customEmbedFunction,
    fields: ["content", "metadata.description"]
  }
});
```

### Field Path Syntax

The `fields` configuration uses JSON path syntax to specify which parts of stored items to embed:

```typescript
const store = new PostgresStore({
  connectionOptions: connectionString,
  index: {
    dims: 1536,
    embed: embeddings,
    fields: [
      "$",                           // Entire document (default)
      "content",                     // Top-level field
      "metadata.title",              // Nested field
      "sections[*].text",            // All array elements
      "chapters[0].summary",         // Specific array index
      "reviews[-1].comment"          // Last array element
    ]
  }
});
```

### Vector Similarity Search

#### Basic Vector Search

```typescript
const results = await store.vectorSearch(
  ["documents"], 
  "machine learning algorithms",
  {
    limit: 10,
    similarityThreshold: 0.7,
    distanceMetric: 'cosine'
  }
);

console.log(results.map(r => ({ key: r.key, score: r.score })));
```

#### Distance Metrics

The store supports three distance metrics:

- **Cosine Distance** (`cosine`): Best for normalized embeddings (default)
- **L2 Distance** (`l2`): Euclidean distance
- **Inner Product** (`inner_product`): For embeddings where magnitude matters

```typescript
// Cosine similarity (default)
const cosineResults = await store.vectorSearch(
  ["docs"], 
  "query",
  { distanceMetric: 'cosine' }
);

// L2 distance
const l2Results = await store.vectorSearch(
  ["docs"], 
  "query", 
  { distanceMetric: 'l2' }
);

// Inner product
const ipResults = await store.vectorSearch(
  ["docs"], 
  "query",
  { distanceMetric: 'inner_product' }
);
```

### Hybrid Search

Combine vector similarity with traditional text search for best results:

```typescript
const hybridResults = await store.hybridSearch(
  ["documents"],
  "artificial intelligence research",
  {
    vectorWeight: 0.7,        // 70% vector, 30% text search
    similarityThreshold: 0.5,
    filter: { category: "research" },
    limit: 20
  }
);
```

### Advanced Filtering with Vector Search

Combine vector search with sophisticated filtering:

```typescript
const results = await store.vectorSearch(
  ["products"],
  "comfortable running shoes",
  {
    filter: {
      category: "footwear",
      price: { $gte: 50, $lte: 200 },
      rating: { $gt: 4.0 },
      inStock: true
    },
    limit: 15,
    similarityThreshold: 0.6
  }
);
```

### Performance Considerations

#### Index Configuration

The store automatically creates appropriate vector indexes:

- **HNSW indexes** for better performance (recommended)
- **IVFFlat indexes** for large datasets
- **Configurable parameters** for performance tuning
- **Multiple distance metrics** support

#### Embedding Optimization

- **Batch embedding generation** for multiple items
- **Efficient text extraction** from JSON paths
- **Automatic dimension validation**
- **Connection pooling** for embedding API calls

#### Query Optimization

- **Similarity thresholds** to limit search scope
- **Combined filtering** to reduce vector search space
- **Proper indexing** on frequently filtered fields
- **Pagination support** for large result sets

### Database Schema

When vector search is enabled, the store creates additional tables:

```sql
-- Vector storage table
CREATE TABLE store_vectors (
  namespace_path TEXT NOT NULL,
  key TEXT NOT NULL,
  field_path TEXT NOT NULL,
  text_content TEXT NOT NULL,
  embedding vector(dims) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (namespace_path, key, field_path),
  FOREIGN KEY (namespace_path, key) REFERENCES store(namespace_path, key) ON DELETE CASCADE
);

-- HNSW vector similarity indexes (recommended)
CREATE INDEX idx_store_vectors_embedding_cosine_hnsw ON store_vectors 
  USING hnsw (embedding vector_cosine_ops) 
  WITH (m = 16, ef_construction = 200);

-- IVFFlat indexes (alternative)
CREATE INDEX idx_store_vectors_embedding_cosine_ivfflat ON store_vectors 
  USING ivfflat (embedding vector_cosine_ops) 
  WITH (lists = 100);
```

### Migration from Text Search

If you're upgrading from text-only search to vector search:

1. **Add vector configuration** to your store initialization
2. **Re-index existing items** by calling `put()` again
3. **Update search calls** to use `vectorSearch()` or `hybridSearch()`
4. **Adjust similarity thresholds** based on your embedding model

```typescript
// Before: Text search only
const results = await store.search(["docs"], { query: "machine learning" });

// After: Vector search
const results = await store.vectorSearch(["docs"], "machine learning");

// Or hybrid search for best results
const results = await store.hybridSearch(["docs"], "machine learning", {
  vectorWeight: 0.8
});
```

### Example Usage

See the [HNSW Vector Search Example](./examples/hnsw-vector-search.ts) for a comprehensive demonstration of vector search capabilities including:

- HNSW vs IVFFlat performance comparison
- Different distance metrics
- Advanced filtering
- Hybrid search
- Performance optimization techniques

## Performance Optimizations

## API Reference

### PostgresStore

#### Constructor

```typescript
new PostgresStore(config: PostgresStoreConfig)
```

#### Methods

##### `setup(): Promise<void>`
Initialize the store by creating necessary tables and indexes. Must be called before using the store.

##### `get(namespace: string[], key: string): Promise<Item | null>`
Retrieve a single item by namespace and key.

##### `put(namespace: string[], key: string, value: Record<string, any>): Promise<void>`
Store or update an item.

##### `delete(namespace: string[], key: string): Promise<void>`
Delete an item.

##### `search(namespacePrefix: string[], options?: SearchOptions): Promise<Item[]>`
Search for items within a namespace prefix.

**SearchOptions:**
- `filter?: Record<string, any>` - Filter by exact field matches
- `query?: string` - Full-text search query
- `limit?: number` - Maximum results (default: 10)
- `offset?: number` - Skip results for pagination (default: 0)

##### `listNamespaces(options?: ListNamespacesOptions): Promise<string[][]>`
List and filter namespaces.

**ListNamespacesOptions:**
- `prefix?: string[]` - Filter by namespace prefix
- `suffix?: string[]` - Filter by namespace suffix  
- `maxDepth?: number` - Limit namespace depth
- `limit?: number` - Maximum results (default: 100)
- `offset?: number` - Skip results for pagination (default: 0)

##### `batch<Op extends Operation[]>(operations: Op): Promise<OperationResults<Op>>`
Execute multiple operations efficiently.

##### `start(): void`
Start the store (calls setup() if ensureTables is true).

##### `stop(): void`
Stop the store and close connections.

##### `end(): Promise<void>`
Close all database connections.

#### Static Methods

##### `fromConnectionString(connectionString: string, options?: Partial<PostgresStoreConfig>): PostgresStore`
Create a store instance from a connection string.

### Types

#### Item
```typescript
interface Item {
  namespace: string[];
  key: string;
  value: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}
```

#### PostgresStoreConfig
```typescript
interface PostgresStoreConfig {
  connectionOptions: string | pg.PoolConfig;
  schema?: string; // default: "public"
  ensureTables?: boolean; // default: true
}
```

## Database Schema

The store creates the following table structure:

```sql
CREATE TABLE {schema}.store (
  namespace_path TEXT NOT NULL,
  key TEXT NOT NULL,
  value JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (namespace_path, key)
);

-- Indexes for performance
CREATE INDEX idx_store_namespace_path ON {schema}.store (namespace_path);
CREATE INDEX idx_store_value_gin ON {schema}.store USING gin (value);
```

## Testing

To run tests, set the `TEST_POSTGRES_URL` environment variable:

```bash
export TEST_POSTGRES_URL="postgresql://user:password@localhost:5432/test_db"
yarn test
```

The tests will create temporary databases for each test run and clean them up automatically.

## Performance Considerations

- **Indexing**: The store automatically creates GIN indexes on JSONB values for efficient filtering
- **Connection Pooling**: Uses pg connection pooling for optimal performance
- **Batch Operations**: Use batch operations for multiple related operations
- **Namespace Design**: Design namespaces to match your query patterns

## Error Handling

The store validates namespaces and throws descriptive errors:

```typescript
try {
  await store.put([], "key", { data: "value" }); // Invalid: empty namespace
} catch (error) {
  console.error(error.message); // "Namespace cannot be empty."
}

try {
  await store.put(["invalid.namespace"], "key", { data: "value" }); // Invalid: contains period
} catch (error) {
  console.error(error.message); // "Namespace labels cannot contain periods ('.')."
}
```

## Migration from Other Stores

If you're migrating from an in-memory store or other storage backend:

1. **Export existing data** using the current store's search/list methods
2. **Create PostgresStore instance** and call setup()
3. **Import data** using batch operations for efficiency
4. **Update application code** to use the new store instance

## License

MIT

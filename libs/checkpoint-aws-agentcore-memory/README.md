# @langchain/langgraph-checkpoint-aws-agentcore-memory

LangGraph checkpointer implementation using AWS Bedrock AgentCore Memory.

## Usage

```typescript
import {
  AgentCoreMemorySaver,
  AgentCoreMemoryStore,
} from "@langchain/langgraph-checkpoint-aws-agentcore-memory";

// Checkpointer for state persistence
const checkpointer = new AgentCoreMemorySaver({
  memoryId: "your-memory-id",
  region: "us-east-1", // optional, defaults to AWS SDK default
});

// Store for key-value data persistence
const store = new AgentCoreMemoryStore({
  memoryId: "your-memory-id",
  region: "us-east-1", // optional, defaults to AWS SDK default
});

// Use with LangGraph
const graph = builder.compile({ checkpointer, store });
```

## Configuration

Both `AgentCoreMemorySaver` and `AgentCoreMemoryStore` require:

- `memoryId`: The AWS Bedrock AgentCore Memory ID
- `region` (optional): AWS region, defaults to SDK default

## Requirements

- AWS credentials configured (via environment variables, IAM roles, or AWS SDK configuration)
- Access to AWS Bedrock AgentCore Memory service
- Required IAM permissions for AgentCore Memory operations

## Features

### AgentCoreMemorySaver

- ✅ Extends `BaseCheckpointSaver` from `@langchain/langgraph-checkpoint`
- ✅ Reuses serialization/deserialization from base library
- ✅ Supports all standard checkpointer operations (getTuple, list, put, putWrites, deleteThread)
- ✅ Thread-based state isolation using AgentCore Memory sessions
- ✅ Automatic retry logic with exponential backoff for AWS API throttling
- ✅ Rate limiting to stay within AgentCore Memory API limits (20 req/sec)
- ✅ Unique actor ID generation for test isolation

### AgentCoreMemoryStore

- ✅ Extends `BaseStore` from `@langchain/langgraph-checkpoint`
- ✅ Supports all standard store operations (get, put, delete, search, batch, listNamespaces)
- ✅ Hierarchical namespace organization for data isolation
- ✅ Metadata filtering and pagination for search operations
- ✅ Complex JSON value support with proper serialization
- ✅ Rate limiting and retry logic consistent with checkpointer
- ✅ Unique actor ID generation per store instance

## Architecture

Both implementations map LangGraph concepts to AgentCore Memory:

### Checkpointer Mapping

- `thread_id` → `sessionId` in AgentCore Memory
- `actor_id` → `actorId` in AgentCore Memory (required for all operations)
- `checkpoint_ns` → stored in event payload and filtered during retrieval

### Store Mapping

- `namespace[0]` → `sessionId` in AgentCore Memory
- `namespace[1]` → `actorId` in AgentCore Memory (with fallback to unique default)
- `namespace` → stored in event payload for hierarchical organization
- Store items → events with "store_item" type in AgentCore Memory

## Testing

Switch to `langgraphjs/libs/checkpoint-aws-agentcore-memory`:

```bash
$ cd langgraphjs/libs/checkpoint-aws-agentcore-memory
```

### Unit Tests

```bash
pnpm test
```

### Integration Tests

Integration tests require AWS credentials and a valid AgentCore Memory ID:

1. Copy `.env.example` to `.env`:

   ```bash
   cp .env.example .env
   ```

2. Set your AWS configuration:

You will need to create an instance of AgentCore Memory in your AWS account. Make sure that AWS credentials are available for your session in your terminal environment.

```bash
AWS_REGION=us-east-1
AGENTCORE_MEMORY_ID=your-actual-memory-id
```

3. Run integration tests:

   ```bash
   # Test checkpointer
   pnmp test:int

   # Test store
   pnmp test:int:store

   # Test both
   pnmp test:int && pnmp test:int:store
   ```

### Validation Tests

Run the comprehensive validation test suite:

```bash
# Run all validation tests
./run-validation-tests.sh

# Run specific test suites
./run-validation-tests.sh getTuple list
./run-validation-tests.sh deleteThread
```

Available test suites: `getTuple`, `list`, `put`, `putWrites`, `deleteThread`

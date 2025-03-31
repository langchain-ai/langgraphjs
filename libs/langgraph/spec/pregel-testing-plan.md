# LangGraphJS Pregel Testing Plan

## Pure Functions and Utilities (Minimal Dependencies)

These components can be tested without complex mocks:

### 1. Configuration Utilities (`utils/config.ts`) ✅

- Test `ensureLangGraphConfig` with various input configurations
- Test namespace handling functions with different formatted namespaces
- Test parent/child checkpoint namespace relationships
- **Status**: All tests implemented and passing

### 2. Validation Logic (`validate.ts`) ✅

- Test graph structure validation with valid/invalid nodes and channels
- Test key validation for reserved channels and duplicate edges
- Test valid channel writing permissions
- **Status**: All tests implemented and passing

### 3. I/O Functions (`io.ts`) ✅

- Test channel reading with single and multiple channels
- Test transformation of input/output values
- Test mapping of commands to appropriate functions
- **Status**: All tests implemented and passing, including `io.mapCommand` testing

### 4. Subgraph Utilities (`utils/subgraph.ts`) ✅

- Test detection of Pregel-like objects in nested structures
- Test finding subgraph Pregel instances at various depths
- **Status**: All tests implemented and passing

### 5. Debug Functions (`debug.ts`) ✅

- Test formatting of task and channel states
- Test checkpoint printing functionality
- **Status**: All tests implemented and passing

## Complex Components with Real Implementations

For components with deeper dependencies, we'll use simplified, real implementations:

### 1. Channel Reading/Writing (`read.ts`, `write.ts`) ✅

**Test Fixtures:**

```typescript
// Simple channel implementation
class TestChannel {
  constructor(private value: any = null) {}
  update(values: any[]) {
    if (values.length > 0) {
      this.value = values[values.length - 1];
      return true;
    }
    return false;
  }
  get() { return this.value; }
}

// Real channel registry
const channels = {
  input: new TestChannel("initial input"),
  intermediate: new TestChannel(),
  output: new TestChannel(),
};
```

**Test Scenarios:**

- Reading from single and multiple channels
- Writing to channels and validating updates
- Combining writes with getWriters
- Error handling for invalid channel operations

**Status**: All tests implemented and passing for both `read.ts` and `write.ts`

### 2. Execution Engine (`loop.ts`, `runner.ts`)

**Test Fixtures:**

```typescript
// Simple in-memory checkpointer
class TestCheckpointer {
  checkpoints = new Map();
  async put(config, checkpoint, metadata) {
    const id = `cp-${Date.now()}`;
    this.checkpoints.set(id, { config, checkpoint, metadata });
    return id;
  }
  async get(id) {
    return this.checkpoints.get(id);
  }
}

// Simple PregelLoop with controllable state
const createTestLoop = () => {
  const channels = {
    input: new TestChannel("input value"),
    output: new TestChannel(),
  };

  const versions = {
    superstep: 0,
    channelVersions: { input: 0, output: 0 },
    nodeLastSeenVersions: {},
    pendingPushes: [],
  };

  return new PregelLoop(channels, versions, new TestCheckpointer());
};
```

**Test Scenarios:**

- Single superstep execution with task completion
- Multi-step progression through a simple workflow
- Checkpointing and restoring execution state
- Error handling and interruption testing

### 3. Algorithm Components (`algo.ts`)

**Test Fixtures:**

```typescript
// Simple node implementation
const createTestNode = (name, inputChannels, outputChannels, fn) => ({
  name,
  readEdges: new Map([[name, inputChannels]]),
  writeEdges: new Map([[name, outputChannels]]),
  bound: {
    invoke: (input) => fn(input),
  },

});

// Test graph setup
const setupTestGraph = () => {
  const channels = {
    input: new TestChannel("initial"),
    middle: new TestChannel(),
    output: new TestChannel(),
  };

  const nodes = {
    node1: createTestNode("node1", ["input"], ["middle"], (input) => ({
      result: `processed ${input.input}`,
    })),
    node2: createTestNode("node2", ["middle"], ["output"], (input) => ({
      result: `finalized ${input.middle}`,
    })),
  };

  return { channels, nodes };
};
```

**Test Scenarios:**

- Applying writes to channels and tracking version changes
- Preparing tasks based on channel triggers
- Task execution with dependencies between nodes
- State propagation through a simple node chain

## Minimal Integration Tests

These tests use minimal but complete implementations to validate system behavior:

```typescript
// Simple three-node graph test
const testCompleteExecution = async () => {
  const { channels, nodes } = setupTestGraph();

  const loop = new PregelLoop(
    channels,
    {
      superstep: 0,
      channelVersions: {},
      nodeLastSeenVersions: {},
      pendingPushes: [],
    },
    new TestCheckpointer()
  );

  const runner = new PregelRunner(loop);

  // Initialize with input
  await loop._first({ input: "test data" });

  // Run execution loop
  while (await loop.tick({})) {
    await runner.tick();
  }

  // Verify final output
  expect(channels.output.get()).toEqual("finalized processed test data");
};
```

## Testing Without Mocks

Key approaches for testing with real components:

1. **Create minimal implementations** of channels, nodes, and checkpointers
2. **Use simple function handlers** instead of complex LLM-based runnables
3. **Build small graph structures** (2-3 nodes) that exercise core functionality
4. **Isolate stateful components** with controlled initialization
5. **Record all state transitions** for debugging and validation

This approach will provide a robust testing strategy for the Pregel components while minimizing the need for complex mocks.

## Progress Summary

| Component                    | Status         | Notes                                                     |
| ---------------------------- | -------------- | --------------------------------------------------------- |
| `utils/config.ts`            | ✅ Complete    | Tests cover configuration merging, namespace handling     |
| `utils/subgraph.ts`          | ✅ Complete    | Tests cover Pregel detection and nested structures        |
| `debug.ts`                   | ✅ Complete    | Tests for task/channel formatting and checkpoint printing |
| `io.ts` + `io.mapCommand.ts` | ✅ Complete    | Tests for command mapping and channel operations          |
| `read.ts`                    | ✅ Complete    | Tests for channel reading with various inputs             |
| `write.ts`                   | ✅ Complete    | Tests for channel writing with validation                 |
| `validate.ts`                | ✅ Complete    | Tests for graph structure validation                      |
| `loop.ts`, `runner.ts`       | 🔄 In Progress | Integration tests needed                                  |
| `algo.ts`                    | 🔄 In Progress | Integration tests needed                                  |
| `remote.ts`                  | ⚠️ Pending     | Type issues in the API client integration                 |

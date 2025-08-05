# LangGraphJS Architecture Specification

This document outlines the key architectural components and their relationships
within the LangGraphJS library.

## Core Architecture Overview

LangGraphJS implements a message-passing computation model based on Google's Pregel
system. The architecture has four main layers with clear dependencies:

1. Channels Layer - Foundation for state management and communication
2. Checkpointer Layer - Persistence and serialization of system state
3. Pregel Layer - Core execution engine implementing the message-passing model
4. Graph Layer - High-level interfaces for building workflows

## Pregel System Overview

The Pregel system implements a bulk synchronous parallel (BSP) processing model:

- Supersteps: Discrete execution phases
- Vertices (Nodes): Processing units that read from and write to channels
- Channels: Communication mediators that manage state and message passing
- Edges: Defined by subscription relationships between nodes and channels
- Checkpoints: Persistent snapshots of system state

### Communication Model:
- Nodes NEVER communicate directly with each other
- All communication is mediated through Channels
- Nodes subscribe to Channels to receive data
- Nodes write to Channels to share data
- Channels can customize how values are accumulated (last value, append to list, etc.)

### Execution Flow:
1. Initialization: Graph structure is defined with nodes, channels, and subscriptions
2. Execution: Proceeds in supersteps where:
   - Nodes read values from their subscribed channels
   - Nodes perform computation in parallel
   - Nodes write values to channels
   - Channels process and aggregate written values
   - System synchronizes between supersteps
3. Termination: Execution stops when no more updates are triggering nodes

## Layer 1: Channels - State Management

Channels provide the foundation for state management and communication, defining
how data is stored, updated, and accessed within the graph.

### Key Interfaces & Classes:
- BaseChannel<ValueType, UpdateType, CheckpointType>: Abstract base for all channels
- EphemeralValue: Simple state container (non-persistent between checkpoints)
- LastValue: Channel that only retains the most recent value
- DynamicBarrierValue: Aggregates values, releases when condition is met
- NamedBarrierValue: Collects values from specific sources before release
- BinaryOperatorAggregate: Applies binary operations to incoming values
- Topic: Special channel that retains a history of messages

### Core Functionality:
- State Management: Store and retrieve state values
- Update Protocol: Define how values are updated and combined
- Checkpointing: Serialize/deserialize state for persistence

## Layer 2: Checkpointer - Persistence

The Checkpointer layer provides persistence capabilities, allowing the system
to save, restore, and replay execution states.

### Key Interfaces & Classes:
- BaseStore: Abstract interface for storing and retrieving checkpoints
- BaseCheckpointSaver: Abstract interface for saving checkpoints
- MemoryStore: In-memory implementation of BaseStore
- CheckpointTuple: Represents a checkpoint with ID, state and metadata
- PendingWrite: Represents a write operation that can be batched

### Plugin Implementations:
- SQLiteStore: Persists checkpoints to SQLite database
- PostgresStore: Persists checkpoints to PostgreSQL database
- MongoDBStore: Persists checkpoints to MongoDB database

### Core Functionality:
- Snapshot Creation: Capture complete system state at a point in time
- Storage & Retrieval: Save and load checkpoints from different backends
- Namespace Management: Organize checkpoints in hierarchical namespaces
- Versioning: Track and manage checkpoint versions
- Time Travel: Enable replay and debugging from past states

## Layer 3: Pregel - Execution Engine

The Pregel layer is the core execution engine implementing the message-passing
computational model.

### Key Classes:
- Pregel: Core runtime engine
- PregelNode: Represents a computation unit that subscribes to channels
- ChannelWrite: Specifies how nodes write to channels
- PregelLoop: Controls the execution flow through supersteps
- PregelRunner: Manages concurrent execution of tasks

### Core Functionality:
- Graph Execution: Orchestrate message flow between nodes
- State Propagation: Update and propagate state throughout graph
- Concurrency: Execute nodes in parallel when possible
- Error Handling: Manage failures and retries
- Streaming: Provide real-time visibility into execution progress
- Persistence: Save and restore execution state

## Layer 4: Graph - Workflow Definition

The Graph layer provides high-level interfaces for building workflows
that leverage the underlying Pregel system.

### Key Classes:
- Graph: Base graph class for defining workflow structure
- StateGraph: Specialized graph for stateful workflows
- CompiledGraph (extends Pregel): Runtime representation of a graph
- Annotation: Type specification for graph state
- Branch: Handles conditional routing between nodes

### Core Functionality:
- Graph Construction: Define nodes, edges, and execution flow
- State Definition: Specify and validate state schemas
- Compilation: Transform graph definitions into executable Pregel instances
- Visualization: Generate visualizations of graph structure

## Key Interface: Channel to Checkpointer

Channels provide checkpointing capabilities that the Checkpointer layer utilizes:

```typescript
abstract class BaseChannel<ValueType, UpdateType, CheckpointType> {
  // Serialization methods used by Checkpointer
  abstract checkpoint(): CheckpointType | undefined;
  abstract fromCheckpoint(checkpoint?: CheckpointType): this;

  // Core channel functionality
  abstract update(values: UpdateType[]): boolean;
  abstract get(): ValueType;
  consume(): boolean;
}

// Creating a checkpoint from channels
function createCheckpoint(
  channels: Record<string, BaseChannel>,
  includeEphemeral: boolean = false
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(channels)
      .filter(([_, c]) => includeEphemeral || !c.isEphemeral)
      .map(([k, c]) => [k, c.checkpoint()])
  );
}
```

## Key Interface: Checkpointer to Pregel

The Pregel system uses the Checkpointer for persistence:

```typescript
class Pregel {
  checkpointer?: BaseCheckpointSaver;
  store?: BaseStore;

  async getState(config?: RunnableConfig, options?: GetStateOptions): Promise<StateSnapshot> {
    const cp = await this.checkpointer?.getTuple(config);
    return this._prepareStateSnapshot(config, cp);
  }

  async getStateHistory(config?: RunnableConfig, options?: GetStateHistoryOptions): Promise<
    AsyncIterable<StateSnapshot>
  > {
    // Returns history of checkpoints for time-travel
  }
  
  async updateState(
    inputConfig: RunnableConfig,
    values: Record<string, any>,
    asNode?: string
  ): Promise<RunnableConfig> {
    // Updates state from external inputs
  }
}

interface StateSnapshot {
  values: Record<string, any>;
  next: Array<string>;
  config: RunnableConfig;
  tasks: PregelTaskDescription[];
  metadata?: CheckpointMetadata;
  createdAt?: string;
}
```

## Key Interface: Channel to Pregel

Channels serve as the communication infrastructure for the Pregel system:

```typescript
abstract class BaseChannel<ValueType, UpdateType, CheckpointType> {
  abstract update(values: UpdateType[]): boolean;
  abstract get(): ValueType;
  abstract checkpoint(): CheckpointType | undefined;
  abstract fromCheckpoint(checkpoint?: CheckpointType): this;
  consume(): boolean;
}

class Pregel {
  channels: Record<string, BaseChannel | ManagedValueSpec>;
}

// Channel is a separate utility class, not part of the BaseChannel hierarchy
class Channel {
  static subscribeTo(channel: string, options?): PregelNode;
  static writeTo(channels: string[], writes?): ChannelWrite;
}

// Example of channel usage in a Pregel system:
const node = Channel.subscribeTo("input_channel");
const write = Channel.writeTo(["output_channel"]);
```

## Key Interface: Checkpointer to Graph

The Graph layer uses Checkpointer for persistence and time-travel:

```typescript
class StateGraph<SD, S, U, N> {
  // When compiling, checkpointer options can be provided
  compile({
    checkpointer,
    store,
    // ...other options
  }: {
    checkpointer?: BaseCheckpointSaver | false;
    store?: BaseStore;
    // ...other options
  }): CompiledStateGraph<S, U, N>;
}

class CompiledStateGraph<S, U, N> extends CompiledGraph {
  // Inherits checkpoint functionality from CompiledGraph/Pregel
  async getState(options?: GetStateOptions): Promise<StateSnapshot>;
  async getCheckpoint(id: string): Promise<CheckpointTuple>;
  async listCheckpoints(options?: CheckpointListOptions): Promise<CheckpointTuple[]>;
}
```

## Key Interface: Pregel to Graph

The Graph layer builds on top of Pregel to provide a high-level API:

```typescript
class Graph {
  // Defines the structure of the workflow
  nodes: Record<string, NodeSpecType>;
  edges: Set<[string, string]>;
  branches: Record<string, Record<string, Branch>>;

  // Compiles this graph definition into an executable CompiledGraph
  compile(): CompiledGraph;
}

class CompiledGraph extends Pregel {
  builder: Graph;

  // These methods are on CompiledGraph, not on Graph
  attachNode(key: string, node: NodeSpec): void;
  attachEdge(start: string, end: string): void;
  attachBranch(start: string, name: string, branch: Branch): void;
}
```

## Execution Flow Interface

The execution flow is orchestrated through several key interfaces:

```typescript
class PregelLoop {
  // Execute one step of the Pregel computation model, returns whether more steps are needed
  tick(params): Promise<boolean>;
  // Handle errors and prepare final output
  finishAndHandleError(error): Promise<void>;
  // Save write operations from a node task
  putWrites(taskId, writes): void;
}

class PregelRunner {
  // Execute tasks with optional retry policies and timeouts
  tick({timeout, retryPolicy, onStepWrite, signal}): Promise<void>;
}

// Pseudo-code showing the execution flow:
const loop = new PregelLoop(channels, checkpointer);
const runner = new PregelRunner(loop);

// Main execution loop
while (await loop.tick(params)) {
  await runner.tick({timeout, retryPolicy});
}

interface StateSnapshot {
  values: Record<string, any>;
  next: Array<string>;
  config: RunnableConfig;
  tasks: PregelTaskDescription[];
  metadata?: CheckpointMetadata;
  createdAt?: string;
  parentConfig?: RunnableConfig;
}
```

## Architecture Principles

1. Separation of Concerns
   - State Management (Channels)
   - Execution Model (Pregel)
   - Workflow Definition (Graph)

2. Extensibility
   - Custom Channels: Create specialized state management behaviors
   - Custom Nodes: Implement domain-specific logic
   - Custom Persistence: Plug in different storage backends

3. Runtime Control
   - Human-in-the-loop: Interrupt execution at specific points
   - Breakpoints: Pause execution for debugging or intervention
   - Time Travel: Replay execution from previous states

4. Streaming and Observability
   - Multiple stream modes:
     - values: Complete state after each step
     - updates: Only state changes
     - messages: Internal node communication
     - debug: Detailed execution events

## System Design Decisions

1. Immutable Patterns
   - Channels produce new state rather than mutating existing state
   - Configurations are composed rather than modified

2. Checkpoint-Based Persistence
   - All state is captured in checkpoints that can be serialized
   - Each superstep creates a new checkpoint
   - Enables reliable recovery and time-travel debugging

3. Typed State Management
   - State schemas are defined through annotations
   - Type safety throughout the execution model
   - Runtime validation of state transitions

4. Async-First Design
   - All operations support asynchronous execution
   - Promise-based API for all external interactions
   - Support for streaming throughout the system
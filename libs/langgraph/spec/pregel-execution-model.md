# LangGraphJS Pregel Execution Model

This document provides a detailed explanation of the Pregel execution model 
implementation in LangGraphJS, showing how components interact to implement
the message-passing computation system.

## Core Components and Their Interactions

The Pregel execution model implements a superstep-based computation with 
message passing between nodes. Three key components work together:

1. **PregelLoop**: Orchestrates the execution cycle
2. **PregelRunner**: Executes tasks concurrently with error handling
3. **Algorithm Functions**: Implement core Pregel logic including superstep preparation,
   message passing, task generation, and execution finalization

## Execution Flow: Step-by-Step

The Pregel execution follows a Bulk Synchronous Parallel (BSP) pattern:

1. Initialize graph structure with nodes and channels
2. For each superstep:
   - Prepare tasks based on channel updates
   - Execute tasks in parallel
   - Apply writes to channels
   - Create checkpoint
3. Terminate when no more updates trigger nodes

```typescript
// Pseudo-code for the main execution flow:
const loop = PregelLoop.initialize({
  channels,
  checkpointer,
  modules,
  readEdges
});

const runner = new PregelRunner();

// Initial input
const config = await _first(input, checkpointOpts);

// Main execution loop
while (await loop.tick({ config })) {
  await runner.tick({
    timeout,
    retryPolicy,
    onStepWrite
  });
}

// Final state
const result = await loop.finishAndHandleError();
```

## PregelLoop: Superstep Orchestration

The PregelLoop manages the graph execution cycle:

```typescript
class PregelLoop {
  // Channels hold state and pass messages
  channels: Record<string, BaseChannel>;
  
  // Tasks scheduled for current superstep
  tasks: PregelTask[];
  
  // Checkpointer for persistence
  checkpointer?: BaseCheckpointSaver;
  
  // Executes a single superstep of the algorithm
  async tick(params: { 
    config?: RunnableConfig,
    signal?: AbortSignal
  }): Promise<boolean> {
    // Handle first execution or continue from checkpoint
    if (firstTime) {
      await this._first(inputKeys);
    }
    
    // Prepare next tasks based on channel updates
    this.tasks = _prepareNextTasks(
      this.channels,
      this.readEdges,
      this.versions
    );
    
    // Create checkpoint for this superstep
    await this._putCheckpoint({ superstep: this.versions.superstep });
    
    // If no more tasks, we're done
    return this.tasks.length > 0;
  }
  
  // Save write operations from tasks
  putWrites(taskId: string, writes: ChannelWrite[]): void {
    this.writesFromTasks[taskId] = writes;
  }
  
  // Process writes after tasks complete
  async _processWritesFromTasks(): Promise<void> {
    for (const [taskId, writes] of Object.entries(this.writesFromTasks)) {
      await _applyWrites(
        this.channels,
        writes,
        this.versions
      );
    }
  }
}
```

## PregelRunner: Parallel Task Execution

The PregelRunner executes tasks from the PregelLoop:

```typescript
class PregelRunner {
  loop: PregelLoop;
  
  // Execute all tasks for the current superstep
  async tick(options?: {
    timeout?: number,
    retryPolicy?: RetryPolicy,
    onStepWrite?: OnStepWriteCallback,
    signal?: AbortSignal
  }): Promise<void> {
    const tasks = this.loop.tasks;
    
    // Execute tasks concurrently with retries
    const results = await this._executeTasksWithRetry(
      tasks,
      options
    );
    
    // Process results
    for (const [taskId, result] of Object.entries(results)) {
      await this._commit(taskId, result);
    }
    
    // Process all writes from tasks
    await this.loop._processWritesFromTasks();
  }
  
  // Execute a single task with retry logic
  async _executeTask(
    task: PregelTask,
    options?: { timeout?: number, signal?: AbortSignal }
  ): Promise<any> {
    // Setup context for task execution
    // Execute the task function with proper context
    // Handle errors and timeouts
    // Return result or throw error
  }
  
  // Process the result of a task
  async _commit(taskId: string, result: any): Promise<void> {
    // Convert result to channel writes
    const writes = _resultToWrites(result, task);
    
    // Save writes to be processed later
    this.loop.putWrites(taskId, writes);
  }
}
```

## Algorithm Functions: Core Pregel Logic

Algorithm functions implement the complete Pregel lifecycle:

```typescript
// Initialize and prepare first superstep
function _first(
  input: any,
  channels: Record<string, BaseChannel>,
  checkpointer?: BaseCheckpointSaver
): RunnableConfig {
  // Initialize channels with input values
  _initializeChannels(channels, input);
  
  // Create initial checkpoint
  const config = _createConfig();
  if (checkpointer) {
    const checkpoint = _createInitialCheckpoint(channels);
    checkpointer.put(config, checkpoint, { superstep: 0 });
  }
  
  return config;
}

// Prepare tasks based on channel updates
function _prepareNextTasks(
  channels: Record<string, BaseChannel>,
  readEdges: ReadEdges,
  versions: Versions
): PregelTask[] {
  const tasks: PregelTask[] = [];
  
  // Add PUSH tasks (explicit function calls)
  for (const pushTask of versions.pendingPushes) {
    tasks.push(_prepareSingleTask(
      pushTask.node,
      pushTask.type,
      channels,
      readEdges,
      versions
    ));
  }
  
  // Add PULL tasks (triggered by channel updates)
  for (const node of readEdges.keys()) {
    if (_shouldExecuteNode(node, channels, readEdges, versions)) {
      tasks.push(_prepareSingleTask(
        node,
        "pull",
        channels,
        readEdges,
        versions
      ));
    }
  }
  
  return tasks;
}

// Apply writes to channels
function _applyWrites(
  channels: Record<string, BaseChannel>,
  writes: ChannelWrite[],
  versions: Versions
): void {
  for (const write of writes) {
    const channel = channels[write.channel];
    const updated = channel.update(write.values);
    
    if (updated) {
      versions.channelVersions[write.channel] += 1;
    }
  }
}

// Finalize execution and prepare result
function _finalize(
  channels: Record<string, BaseChannel>,
  outputChannels: string[]
): any {
  // Extract final values from output channels
  if (outputChannels.length === 1) {
    // Single output channel case
    return channels[outputChannels[0]].get();
  } else {
    // Multiple output channels case
    return Object.fromEntries(
      outputChannels.map(name => [name, channels[name].get()])
    );
  }
}
```

## Channel-Based Message Passing

Channels mediate all communication between nodes:

```typescript
// Nodes read from channels they subscribe to
function _readFromChannels(
  node: string,
  channels: Record<string, BaseChannel>,
  readEdges: ReadEdges
): Record<string, any> {
  const reads: Record<string, any> = {};
  
  for (const channelName of readEdges.get(node) || []) {
    reads[channelName] = channels[channelName].get();
  }
  
  return reads;
}

// Nodes write to channels to share data
function _writeToChannels(
  writes: ChannelWrite[],
  channels: Record<string, BaseChannel>,
  versions: Versions
): void {
  for (const write of writes) {
    const channel = channels[write.channel];
    const updated = channel.update(write.values);
    
    if (updated) {
      versions.channelVersions[write.channel] += 1;
    }
  }
}
```

## Versioning System

The versioning system tracks changes to determine which nodes to execute:

```typescript
interface Versions {
  // Current superstep number
  superstep: number;
  
  // Version number for each channel
  channelVersions: Record<string, number>;
  
  // Last seen version by each node
  nodeLastSeenVersions: Record<string, Record<string, number>>;
  
  // Tasks waiting to be executed
  pendingPushes: PendingPushTask[];
}

// Determine if a node should execute based on versions
function _shouldExecuteNode(
  node: string,
  channels: Record<string, BaseChannel>,
  readEdges: ReadEdges,
  versions: Versions
): boolean {
  const nodeEdges = readEdges.get(node) || [];
  
  for (const channelName of nodeEdges) {
    const channel = channels[channelName];
    if (!channel.isEmpty()) {
      const lastSeenVersion = versions.nodeLastSeenVersions[node]?.[channelName] || 0;
      const currentVersion = versions.channelVersions[channelName];
      
      // If node hasn't seen the latest version, it should execute
      if (lastSeenVersion < currentVersion) {
        return true;
      }
    }
  }
  
  return false;
}
```

## Checkpointing System

The checkpointing system enables persistence and time-travel:

```typescript
// Create checkpoint after each superstep
async function _putCheckpoint(
  channels: Record<string, BaseChannel>,
  checkpointer: BaseCheckpointSaver,
  config: RunnableConfig,
  metadata: CheckpointMetadata
): Promise<string | undefined> {
  // Collect channel states
  const checkpoint = Object.fromEntries(
    Object.entries(channels)
      .filter(([_, c]) => !c.isEphemeral)
      .map(([k, c]) => [k, c.checkpoint()])
  );
  
  // Save checkpoint
  return checkpointer.put(config, checkpoint, metadata);
}

// Restore from checkpoint
async function _restoreFromCheckpoint(
  channels: Record<string, BaseChannel>,
  store: BaseStore,
  checkpointId: string
): Promise<void> {
  const checkpoint = await store.get(checkpointId);
  
  // Restore each channel
  for (const [name, state] of Object.entries(checkpoint.checkpoint)) {
    channels[name]?.fromCheckpoint(state);
  }
}
```

## Key Feature: Human-in-the-Loop

The system supports human intervention via interrupts:

```typescript
// Interrupt execution to wait for human input
function interruptFor(
  reason: string,
  metadata: Record<string, any> = {}
): never {
  throw new InterruptError(reason, metadata);
}

// Handle interrupts in the main execution loop
try {
  while (await loop.tick(config)) {
    await runner.tick();
  }
} catch (e) {
  if (e instanceof InterruptError) {
    // Save current state
    const checkpoint = await loop._putCheckpoint({
      superstep: versions.superstep,
      reason: e.reason,
      metadata: e.metadata
    });
    
    // Return to caller with interrupt info
    return {
      checkpoint,
      reason: e.reason,
      metadata: e.metadata
    };
  }
  throw e;
}
```

## Advanced Feature: Streaming

The system provides streaming capabilities for real-time insights:

```typescript
enum StreamMode {
  VALUES = "values",     // Complete state after each step
  UPDATES = "updates",   // Only state changes
  MESSAGES = "messages", // Internal node communication
  DEBUG = "debug"        // Detailed execution events
}

// Stream handler function
function _emit(
  config: RunnableConfig,
  mode: StreamMode,
  values: any
): void {
  const handlers = config.configurable?.callbacks?.[mode];
  if (handlers) {
    for (const handler of handlers) {
      handler(values);
    }
  }
}

// Stream values from PregelLoop
PregelLoop.prototype._streamValues = function(
  config: RunnableConfig,
  snapshot: StateSnapshot
): void {
  _emit(config, StreamMode.VALUES, snapshot);
};

// Stream updates from PregelLoop
PregelLoop.prototype._streamUpdates = function(
  config: RunnableConfig,
  updates: Record<string, any>
): void {
  _emit(config, StreamMode.UPDATES, updates);
};
```
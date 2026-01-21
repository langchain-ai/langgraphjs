import type { Message, DefaultToolCall } from "../types.messages.js";
import type { NodeStream, NodeStatus } from "./types.js";
import { MessageTupleManager, toMessageDict } from "./messages.js";

/**
 * Options for NodeManager.
 */
export interface NodeManagerOptions {
  /**
   * Callback when node state changes.
   */
  onNodeChange?: () => void;
}

/**
 * Internal base type for NodeStream storage.
 * Excludes derived properties that are computed on retrieval.
 */
type NodeStreamBase = Omit<NodeStream, "isLoading">;

/**
 * Manages node execution state for LangGraph streams.
 *
 * Tracks node executions from the moment they start through streaming
 * to completion. Handles multiple executions of the same node (e.g., in loops).
 *
 * Node execution information is extracted from:
 * - `langgraph_node` metadata in message events
 * - `updates` stream events with node name keys
 *
 * @example
 * ```typescript
 * const manager = new NodeManager({ onNodeChange: () => console.log('changed') });
 *
 * // Start a node
 * manager.startNode("researcher");
 *
 * // Add a message to the current execution
 * manager.addMessage("researcher", aiMessage, metadata);
 *
 * // Record an update from the node
 * manager.recordUpdate("researcher", { research_notes: "..." });
 *
 * // Complete the node
 * manager.completeNode("researcher");
 *
 * // Get all executions of a node
 * const executions = manager.getNodeStreamsByName("researcher");
 * ```
 */
export class NodeManager<
  StateType extends Record<string, unknown> = Record<string, unknown>
> {
  /**
   * All node executions, keyed by unique execution ID.
   */
  private nodes = new Map<string, NodeStreamBase>();

  /**
   * Maps node names to their current (most recent) execution ID.
   * Used to route messages and updates to the correct execution.
   */
  private currentExecutionByNode = new Map<string, string>();

  /**
   * Message managers for each node execution.
   * Uses the same MessageTupleManager as the main stream for proper
   * message chunk concatenation.
   */
  private messageManagers = new Map<string, MessageTupleManager>();

  /**
   * Counter for generating unique execution IDs.
   */
  private executionCounter = 0;

  private onNodeChange?: () => void;

  constructor(options?: NodeManagerOptions) {
    this.onNodeChange = options?.onNodeChange;
  }

  /**
   * Generate a unique execution ID for a node.
   */
  private generateExecutionId(nodeName: string): string {
    this.executionCounter += 1;
    return `${nodeName}:${this.executionCounter}:${Date.now()}`;
  }

  /**
   * Get or create a MessageTupleManager for a node execution.
   */
  private getMessageManager(executionId: string): MessageTupleManager {
    let manager = this.messageManagers.get(executionId);
    if (!manager) {
      manager = new MessageTupleManager();
      this.messageManagers.set(executionId, manager);
    }
    return manager;
  }

  /**
   * Get messages for a node execution with proper chunk concatenation.
   */
  private getMessagesForExecution(executionId: string): Message[] {
    const manager = this.messageManagers.get(executionId);
    if (!manager) return [];

    const messages: Message[] = [];
    for (const entry of Object.values(manager.chunks)) {
      if (entry.chunk) {
        messages.push(toMessageDict(entry.chunk) as Message);
      }
    }
    return messages;
  }

  /**
   * Create a complete NodeStream object with derived properties.
   */
  private createNodeStream(base: NodeStreamBase): NodeStream {
    // Get fresh messages from the manager
    const messages = this.getMessagesForExecution(base.id);
    return {
      ...base,
      messages,
      isLoading: base.status === "running",
    };
  }

  /**
   * Get the current execution ID for a node, or create a new execution if none exists.
   * This ensures messages are routed to the correct execution.
   */
  private getOrCreateCurrentExecution(nodeName: string): string {
    let executionId = this.currentExecutionByNode.get(nodeName);

    // If no current execution, or the current one is complete, start a new one
    if (executionId) {
      const existing = this.nodes.get(executionId);
      if (existing && existing.status !== "running") {
        // Current execution is complete, start a new one
        executionId = undefined;
      }
    }

    if (!executionId) {
      executionId = this.startNode(nodeName);
    }

    return executionId;
  }

  /**
   * Start a new node execution.
   * Returns the execution ID for the new execution.
   *
   * @param nodeName - The name of the node
   * @returns The execution ID for the new execution
   */
  startNode(nodeName: string): string {
    const executionId = this.generateExecutionId(nodeName);

    const execution: NodeStreamBase = {
      id: executionId,
      name: nodeName,
      messages: [],
      values: {},
      update: undefined,
      status: "running",
      startedAt: new Date(),
      completedAt: null,
    };

    this.nodes.set(executionId, execution);
    this.currentExecutionByNode.set(nodeName, executionId);
    this.getMessageManager(executionId);

    this.onNodeChange?.();
    return executionId;
  }

  /**
   * Add a message to a node's current execution.
   *
   * @param nodeName - The name of the node
   * @param serialized - The serialized message from the stream
   * @param metadata - Optional metadata from the stream event
   */
  addMessage(
    nodeName: string,
    serialized: Message<DefaultToolCall>,
    metadata?: Record<string, unknown>
  ): void {
    const executionId = this.getOrCreateCurrentExecution(nodeName);
    const existing = this.nodes.get(executionId);
    if (!existing) return;

    const manager = this.getMessageManager(executionId);
    manager.add(serialized, metadata);

    // Update the cached messages
    this.nodes.set(executionId, {
      ...existing,
      messages: this.getMessagesForExecution(executionId),
    });

    this.onNodeChange?.();
  }

  /**
   * Record an update payload from a node and mark it as complete.
   *
   * In LangGraph, when a node sends an update event, it has finished executing.
   * The update contains the node's output that will be merged into the graph state.
   *
   * @param nodeName - The name of the node
   * @param update - The partial state update from the node
   */
  recordUpdate(nodeName: string, update: Partial<StateType>): void {
    const executionId = this.getOrCreateCurrentExecution(nodeName);
    const existing = this.nodes.get(executionId);
    if (!existing) return;

    // Merge with existing update if present
    const mergedUpdate = existing.update
      ? { ...existing.update, ...update }
      : update;

    // When we receive an update, the node has completed its work
    this.nodes.set(executionId, {
      ...existing,
      update: mergedUpdate,
      status: "complete",
      completedAt: new Date(),
    });

    // Clear the current execution mapping so next call starts a new execution
    this.currentExecutionByNode.delete(nodeName);

    this.onNodeChange?.();
  }

  /**
   * Update values for a node execution.
   *
   * @param nodeName - The name of the node
   * @param values - The node's local values
   */
  updateValues(nodeName: string, values: Record<string, unknown>): void {
    const executionId = this.getOrCreateCurrentExecution(nodeName);
    const existing = this.nodes.get(executionId);
    if (!existing) return;

    this.nodes.set(executionId, {
      ...existing,
      values,
    });

    this.onNodeChange?.();
  }

  /**
   * Complete a node's current execution.
   *
   * @param nodeName - The name of the node
   * @param status - The final status (defaults to "complete")
   */
  completeNode(
    nodeName: string,
    status: Extract<NodeStatus, "complete" | "error"> = "complete"
  ): void {
    const executionId = this.currentExecutionByNode.get(nodeName);
    if (!executionId) return;

    const existing = this.nodes.get(executionId);
    if (!existing) return;

    this.nodes.set(executionId, {
      ...existing,
      status,
      completedAt: new Date(),
    });

    // Clear the current execution mapping so the next call starts fresh
    this.currentExecutionByNode.delete(nodeName);

    this.onNodeChange?.();
  }

  /**
   * Get all node executions as a Map.
   */
  getNodes(): Map<string, NodeStream> {
    const result = new Map<string, NodeStream>();
    for (const [id, node] of this.nodes) {
      result.set(id, this.createNodeStream(node));
    }
    return result;
  }

  /**
   * Get all currently running nodes.
   */
  getActiveNodes(): NodeStream[] {
    return [...this.nodes.values()]
      .filter((n) => n.status === "running")
      .map((n) => this.createNodeStream(n));
  }

  /**
   * Get a specific node execution by ID.
   *
   * @param executionId - The unique execution ID
   */
  getNodeStream(executionId: string): NodeStream | undefined {
    const node = this.nodes.get(executionId);
    return node ? this.createNodeStream(node) : undefined;
  }

  /**
   * Get all executions of a specific node by name.
   *
   * @param nodeName - The name of the node
   * @returns Array of all executions, ordered by start time (oldest first)
   */
  getNodeStreamsByName(nodeName: string): NodeStream[] {
    return [...this.nodes.values()]
      .filter((n) => n.name === nodeName)
      .sort((a, b) => {
        const aTime = a.startedAt?.getTime() ?? 0;
        const bTime = b.startedAt?.getTime() ?? 0;
        return aTime - bTime;
      })
      .map((n) => this.createNodeStream(n));
  }

  /**
   * Check if any node executions are currently tracked.
   */
  hasNodes(): boolean {
    return this.nodes.size > 0;
  }

  /**
   * Clear all node state.
   */
  clear(): void {
    this.nodes.clear();
    this.currentExecutionByNode.clear();
    this.messageManagers.clear();
    this.executionCounter = 0;
    this.onNodeChange?.();
  }
}

import type { Message, DefaultToolCall } from "../types.messages.js";
import type { SubagentExecution, SubagentToolCall } from "./types.js";
import { MessageTupleManager, toMessageDict } from "./messages.js";

/**
 * Default tool names that indicate subagent invocation.
 * Can be customized via SubagentManager options.
 */
const DEFAULT_SUBAGENT_TOOL_NAMES = ["task"];

/**
 * Checks if a namespace indicates a subagent/subgraph message.
 *
 * Subagent namespaces contain a "tools:" segment indicating they
 * originate from a tool call that spawned a subgraph.
 *
 * @param namespace - The namespace array from stream events (or checkpoint_ns string)
 * @returns True if this is a subagent namespace
 */
export function isSubagentNamespace(
  namespace: string[] | string | undefined
): boolean {
  if (!namespace) return false;

  // Handle string namespace (from checkpoint_ns)
  if (typeof namespace === "string") {
    return namespace.includes("tools:");
  }

  // Handle array namespace
  return namespace.some((s) => s.startsWith("tools:"));
}

/**
 * Extracts the tool call ID from a namespace path.
 *
 * Namespaces follow the pattern: ["tools:call_abc123", "model_request:xyz", ...]
 * This function extracts "call_abc123" from the first "tools:" segment.
 *
 * @param namespace - The namespace array from stream events
 * @returns The tool call ID, or undefined if not found
 */
export function extractToolCallIdFromNamespace(
  namespace: string[] | undefined
): string | undefined {
  if (!namespace || namespace.length === 0) return undefined;

  // Find the first namespace segment that starts with "tools:"
  for (const segment of namespace) {
    if (segment.startsWith("tools:")) {
      return segment.slice(6); // Remove "tools:" prefix
    }
  }

  return undefined;
}

/**
 * Calculates the depth of a subagent based on its namespace.
 * Counts the number of "tools:" segments in the namespace.
 *
 * @param namespace - The namespace array
 * @returns The depth (0 for main agent, 1+ for subagents)
 */
export function calculateDepthFromNamespace(
  namespace: string[] | undefined
): number {
  if (!namespace) return 0;
  return namespace.filter((s) => s.startsWith("tools:")).length;
}

/**
 * Extracts the parent tool call ID from a namespace.
 *
 * For nested subagents, the namespace looks like:
 * ["tools:parent_id", "tools:child_id", ...]
 *
 * @param namespace - The namespace array
 * @returns The parent tool call ID, or null if this is a top-level subagent
 */
export function extractParentIdFromNamespace(
  namespace: string[] | undefined
): string | null {
  if (!namespace || namespace.length < 2) return null;

  const toolSegments = namespace.filter((s) => s.startsWith("tools:"));
  if (toolSegments.length < 2) return null;

  // The second-to-last "tools:" segment is the parent
  return toolSegments[toolSegments.length - 2]?.slice(6) ?? null;
}

/**
 * Options for SubagentManager.
 */
export interface SubagentManagerOptions {
  /**
   * Tool names that indicate subagent invocation.
   * Defaults to ["task"].
   */
  subagentToolNames?: string[];

  /**
   * Callback when subagent state changes.
   */
  onSubagentChange?: () => void;
}

/**
 * Manages subagent execution state.
 *
 * Tracks subagents from the moment they are invoked (AI message with tool calls)
 * through streaming to completion (tool message result).
 */
export class SubagentManager<ToolCall = DefaultToolCall> {
  private subagents = new Map<string, SubagentExecution<ToolCall>>();

  /**
   * Maps namespace IDs (pregel task IDs) to tool call IDs.
   * LangGraph subgraphs use internal pregel task IDs in their namespace,
   * which are different from the tool_call_id used to invoke them.
   */
  private namespaceToToolCallId = new Map<string, string>();

  /**
   * Pending namespace matches that couldn't be resolved immediately.
   * These are retried when new tool calls are registered.
   */
  private pendingMatches = new Map<string, string>(); // namespaceId -> description

  /**
   * Message managers for each subagent.
   * Uses the same MessageTupleManager as the main stream for proper
   * message chunk concatenation.
   */
  private messageManagers = new Map<string, MessageTupleManager>();

  private subagentToolNames: Set<string>;

  private onSubagentChange?: () => void;

  constructor(options?: SubagentManagerOptions) {
    this.subagentToolNames = new Set(
      options?.subagentToolNames ?? DEFAULT_SUBAGENT_TOOL_NAMES
    );
    this.onSubagentChange = options?.onSubagentChange;
  }

  /**
   * Get or create a MessageTupleManager for a subagent.
   */
  private getMessageManager(toolCallId: string): MessageTupleManager {
    let manager = this.messageManagers.get(toolCallId);
    if (!manager) {
      manager = new MessageTupleManager();
      this.messageManagers.set(toolCallId, manager);
    }
    return manager;
  }

  /**
   * Get messages for a subagent with proper chunk concatenation.
   * This mirrors how the main stream handles messages.
   */
  private getMessagesForSubagent(toolCallId: string): Message<ToolCall>[] {
    const manager = this.messageManagers.get(toolCallId);
    if (!manager) return [];

    // Convert chunks to messages in order
    const messages: Message<ToolCall>[] = [];
    for (const entry of Object.values(manager.chunks)) {
      if (entry.chunk) {
        messages.push(toMessageDict(entry.chunk) as Message<ToolCall>);
      }
    }
    return messages;
  }

  /**
   * Get the tool call ID for a given namespace ID.
   * Returns the namespace ID itself if no mapping exists.
   */
  getToolCallIdFromNamespace(namespaceId: string): string {
    return this.namespaceToToolCallId.get(namespaceId) ?? namespaceId;
  }

  /**
   * Try to match a subgraph to a pending subagent by description.
   * Creates a mapping from namespace ID to tool call ID if a match is found.
   *
   * Uses a multi-pass matching strategy:
   * 1. Exact description match
   * 2. Description contains/partial match
   * 3. Any unmapped pending subagent (fallback)
   *
   * @param namespaceId - The namespace ID (pregel task ID) from the subgraph
   * @param description - The description from the subgraph's initial message
   * @returns The matched tool call ID, or undefined if no match
   */
  matchSubgraphToSubagent(
    namespaceId: string,
    description: string
  ): string | undefined {
    // Skip if we already have a mapping
    if (this.namespaceToToolCallId.has(namespaceId)) {
      return this.namespaceToToolCallId.get(namespaceId);
    }

    // Get all already-mapped tool call IDs
    const mappedToolCallIds = new Set(this.namespaceToToolCallId.values());

    // Helper to establish mapping and mark as running
    const establishMapping = (toolCallId: string): string => {
      this.namespaceToToolCallId.set(namespaceId, toolCallId);
      // Also mark the subagent as running since we now have its namespace
      const subagent = this.subagents.get(toolCallId);
      if (subagent && subagent.status === "pending") {
        this.subagents.set(toolCallId, {
          ...subagent,
          status: "running",
          namespace: [namespaceId],
          startedAt: new Date(),
        });
        this.onSubagentChange?.();
      }
      return toolCallId;
    };

    // Pass 1: Find a pending subagent with exact description match
    for (const [toolCallId, subagent] of this.subagents) {
      if (
        (subagent.status === "pending" || subagent.status === "running") &&
        !mappedToolCallIds.has(toolCallId) &&
        subagent.toolCall.args.description === description
      ) {
        return establishMapping(toolCallId);
      }
    }

    // Pass 2: Find a pending subagent where description contains or is contained
    for (const [toolCallId, subagent] of this.subagents) {
      if (
        (subagent.status === "pending" || subagent.status === "running") &&
        !mappedToolCallIds.has(toolCallId)
      ) {
        const subagentDesc = subagent.toolCall.args.description || "";
        if (
          (subagentDesc && description.includes(subagentDesc)) ||
          (subagentDesc && subagentDesc.includes(description))
        ) {
          // Update the description if the new one is longer
          if (description.length > subagentDesc.length) {
            this.subagents.set(toolCallId, {
              ...subagent,
              toolCall: {
                ...subagent.toolCall,
                args: {
                  ...subagent.toolCall.args,
                  description,
                },
              },
            });
          }
          return establishMapping(toolCallId);
        }
      }
    }

    // No match found - store for retry when more tool calls are registered
    if (description) {
      this.pendingMatches.set(namespaceId, description);
    }
    return undefined;
  }

  /**
   * Check if a tool call is a subagent invocation.
   */
  isSubagentToolCall(toolName: string): boolean {
    return this.subagentToolNames.has(toolName);
  }

  /**
   * Check if a subagent_type value is valid.
   * Valid types are proper identifiers like "weather-scout", "experience-curator".
   */
  private isValidSubagentType(type: unknown): boolean {
    // Must be a non-empty string
    if (!type || typeof type !== "string") {
      return false;
    }

    // Must be at least 3 characters (avoids partial streaming like "ex")
    if (type.length < 3) {
      return false;
    }

    // Must look like a valid identifier (letters, numbers, hyphens, underscores)
    // Examples: "weather-scout", "experience_curator", "budget-optimizer"
    if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(type)) {
      return false;
    }

    // Must not be unreasonably long (corruption indicator)
    if (type.length > 50) {
      return false;
    }

    return true;
  }

  /**
   * Check if a subagent should be shown to the user.
   * Subagents are only shown once they've actually started running.
   *
   * This filters out:
   * - Pending subagents that haven't been matched to a namespace yet
   * - Streaming artifacts with partial/corrupted data
   *
   * The idea is: we register subagents internally when we see tool calls,
   * but we only show them to the user once LangGraph confirms they're
   * actually executing (via namespace events).
   */
  private isValidSubagent(subagent: SubagentExecution<ToolCall>): boolean {
    // Only show subagents that have started running or completed
    // This ensures we don't show partial/pending subagents
    return subagent.status === "running" || subagent.status === "complete";
  }

  /**
   * Get all subagents as a Map.
   * Filters out incomplete/phantom subagents that lack subagent_type.
   */
  getSubagents(): Map<string, SubagentExecution<ToolCall>> {
    const result = new Map<string, SubagentExecution<ToolCall>>();
    for (const [id, subagent] of this.subagents) {
      if (this.isValidSubagent(subagent)) {
        result.set(id, subagent);
      }
    }
    return result;
  }

  /**
   * Get all currently running subagents.
   * Filters out incomplete/phantom subagents.
   */
  getActiveSubagents(): SubagentExecution<ToolCall>[] {
    return [...this.subagents.values()].filter(
      (s) => s.status === "running" && this.isValidSubagent(s)
    );
  }

  /**
   * Get a specific subagent by tool call ID.
   */
  getSubagent(toolCallId: string): SubagentExecution<ToolCall> | undefined {
    return this.subagents.get(toolCallId);
  }

  /**
   * Get all subagents of a specific type.
   */
  getSubagentsByType(type: string): SubagentExecution<ToolCall>[] {
    return [...this.subagents.values()].filter(
      (s) => s.toolCall.args.subagent_type === type
    );
  }

  /**
   * Parse tool call args, handling both object and string formats.
   * During streaming, args might come as a string that needs parsing.
   */
  private parseArgs(
    args: Record<string, unknown> | string | undefined
  ): Record<string, unknown> {
    if (!args) return {};
    if (typeof args === "string") {
      try {
        return JSON.parse(args);
      } catch {
        return {};
      }
    }
    return args;
  }

  /**
   * Register new subagent(s) from AI message tool calls.
   *
   * Called when an AI message is received with tool calls.
   * Creates pending subagent entries for each subagent tool call.
   *
   * @param toolCalls - The tool calls from an AI message
   */
  registerFromToolCalls(
    toolCalls: Array<{
      id?: string;
      name: string;
      args: Record<string, unknown> | string;
    }>
  ): void {
    let hasChanges = false;

    for (const toolCall of toolCalls) {
      if (!toolCall.id) continue;
      if (!this.isSubagentToolCall(toolCall.name)) continue;

      // Parse args (may be string during streaming)
      const parsedArgs = this.parseArgs(toolCall.args);

      // Skip tool calls that have no meaningful info (likely streaming artifacts)
      // We require a valid subagent_type that looks like a proper identifier
      const hasValidType = this.isValidSubagentType(parsedArgs.subagent_type);

      // If we already have this subagent, update the args if they're now more complete
      const existing = this.subagents.get(toolCall.id);
      if (existing) {
        // Only update if new values are valid AND longer (more complete)
        const newType = (parsedArgs.subagent_type as string) || "";
        const oldType = existing.toolCall.args.subagent_type || "";
        const newDesc = (parsedArgs.description as string) || "";
        const oldDesc = existing.toolCall.args.description || "";

        // Only accept new type if it's valid (not corrupted)
        const newTypeIsValid = this.isValidSubagentType(newType);
        const shouldUpdateType =
          newTypeIsValid && newType.length > oldType.length;
        const shouldUpdateDesc = newDesc.length > oldDesc.length;

        if (shouldUpdateType || shouldUpdateDesc) {
          this.subagents.set(toolCall.id, {
            ...existing,
            toolCall: {
              ...existing.toolCall,
              args: {
                ...existing.toolCall.args,
                ...parsedArgs,
                description: shouldUpdateDesc ? newDesc : oldDesc,
                subagent_type: shouldUpdateType ? newType : oldType,
              },
            },
          });
          hasChanges = true;
        }
        continue;
      }

      // Don't register subagents without at least a valid-looking subagent_type
      // Partial streaming is OK - we filter by status when displaying
      if (!hasValidType) {
        continue;
      }

      const subagentToolCall: SubagentToolCall = {
        id: toolCall.id,
        name: toolCall.name,
        args: {
          description: parsedArgs.description as string | undefined,
          subagent_type: parsedArgs.subagent_type as string | undefined,
          ...parsedArgs,
        },
      };

      const execution: SubagentExecution<ToolCall> = {
        id: toolCall.id,
        toolCall: subagentToolCall,
        status: "pending",
        result: null,
        error: null,
        namespace: [],
        messages: [],
        parentId: null,
        depth: 0,
        startedAt: null,
        completedAt: null,
      };

      this.subagents.set(toolCall.id, execution);
      // Create a message manager for this subagent
      this.getMessageManager(toolCall.id);
      hasChanges = true;
    }

    // Retry any pending matches now that we have new/updated tool calls
    if (hasChanges) {
      this.retryPendingMatches();
      this.onSubagentChange?.();
    }
  }

  /**
   * Retry matching pending namespaces to newly registered tool calls.
   */
  private retryPendingMatches(): void {
    if (this.pendingMatches.size === 0) return;

    // Try to match each pending namespace
    for (const [namespaceId, description] of this.pendingMatches) {
      // Skip if already matched
      if (this.namespaceToToolCallId.has(namespaceId)) {
        this.pendingMatches.delete(namespaceId);
        continue;
      }

      // Try to match - this will establish mapping if successful
      const matched = this.matchSubgraphToSubagent(namespaceId, description);
      if (matched) {
        this.pendingMatches.delete(namespaceId);
      }
    }
  }

  /**
   * Mark a subagent as running and update its namespace.
   *
   * Called when update events are received with a namespace indicating
   * which subagent is streaming.
   *
   * @param toolCallId - The tool call ID of the subagent
   * @param options - Additional update options
   */
  markRunning(
    toolCallId: string,
    options?: {
      namespace?: string[];
    }
  ): void {
    const existing = this.subagents.get(toolCallId);
    if (!existing) return;

    const namespace = options?.namespace ?? existing.namespace;

    this.subagents.set(toolCallId, {
      ...existing,
      status: "running",
      namespace,
      parentId:
        existing.parentId ?? extractParentIdFromNamespace(namespace) ?? null,
      depth: existing.depth || calculateDepthFromNamespace(namespace),
      startedAt: existing.startedAt ?? new Date(),
    });

    this.onSubagentChange?.();
  }

  /**
   * Mark a subagent as running using a namespace ID.
   * Resolves the namespace ID to the actual tool call ID via the mapping.
   *
   * @param namespaceId - The namespace ID (pregel task ID) from the subgraph
   * @param namespace - The full namespace array
   */
  markRunningFromNamespace(namespaceId: string, namespace?: string[]): void {
    const toolCallId = this.getToolCallIdFromNamespace(namespaceId);
    this.markRunning(toolCallId, { namespace });
  }

  /**
   * Add a serialized message to a subagent from stream events.
   *
   * This method handles the raw serialized message data from SSE events.
   * Uses MessageTupleManager for proper chunk concatenation, matching
   * how the main stream handles messages.
   *
   * @param namespaceId - The namespace ID (pregel task ID) from the stream
   * @param serialized - The serialized message from the stream
   * @param metadata - Optional metadata from the stream event
   */
  addMessageToSubagent(
    namespaceId: string,
    serialized: Message<DefaultToolCall>,
    metadata?: Record<string, unknown>
  ): void {
    // First, try to match this namespace to an existing subagent
    // For human messages (which contain the description), try to establish the mapping
    if (serialized.type === "human" && typeof serialized.content === "string") {
      this.matchSubgraphToSubagent(namespaceId, serialized.content);
    }

    // Resolve the actual tool call ID from the namespace mapping
    const toolCallId = this.getToolCallIdFromNamespace(namespaceId);
    const existing = this.subagents.get(toolCallId);

    // If we still don't have a match, the mapping hasn't been established yet.
    // Don't create a placeholder - just skip this message.
    // The values event will establish the mapping, and subsequent messages
    // will be routed correctly.
    if (!existing) {
      return;
    }

    // Use MessageTupleManager for proper chunk concatenation
    // This is the same approach used by the main stream
    const manager = this.getMessageManager(toolCallId);
    const messageId = manager.add(serialized, metadata);

    if (messageId) {
      // Update the subagent status if this is an AI message with content
      if (serialized.type === "ai") {
        this.subagents.set(toolCallId, {
          ...existing,
          status: "running",
          startedAt: existing.startedAt ?? new Date(),
          // Messages are derived from the manager, so we update them here
          messages: this.getMessagesForSubagent(toolCallId),
        });
      } else {
        // For other message types, just update the messages
        this.subagents.set(toolCallId, {
          ...existing,
          messages: this.getMessagesForSubagent(toolCallId),
        });
      }
    }

    this.onSubagentChange?.();
  }

  /**
   * Complete a subagent with a result.
   *
   * Called when a tool message is received for the subagent.
   *
   * @param toolCallId - The tool call ID of the subagent
   * @param result - The result content
   * @param status - The final status (complete or error)
   */
  complete(
    toolCallId: string,
    result: string,
    status: "complete" | "error" = "complete"
  ): void {
    const existing = this.subagents.get(toolCallId);
    if (!existing) return;

    this.subagents.set(toolCallId, {
      ...existing,
      status,
      result: status === "complete" ? result : null,
      error: status === "error" ? result : null,
      completedAt: new Date(),
    });

    this.onSubagentChange?.();
  }

  /**
   * Clear all subagent state.
   */
  clear(): void {
    this.subagents.clear();
    this.namespaceToToolCallId.clear();
    this.messageManagers.clear();
    this.pendingMatches.clear();
    this.onSubagentChange?.();
  }

  /**
   * Process a tool message to complete a subagent.
   *
   * @param toolCallId - The tool call ID from the tool message
   * @param content - The result content
   * @param status - Whether the tool execution was successful
   */
  processToolMessage(
    toolCallId: string,
    content: string,
    status: "success" | "error" = "success"
  ): void {
    const existing = this.subagents.get(toolCallId);
    if (!existing) return;

    this.complete(
      toolCallId,
      content,
      status === "success" ? "complete" : "error"
    );
  }
}

import type { RunnableConfig } from "@langchain/core/runnables";
import {
  BaseCheckpointSaver,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointTuple,
  type SerializerProtocol,
  type PendingWrite,
  type CheckpointMetadata,
  type ChannelVersions,
  copyCheckpoint,
  TASKS,
  maxChannelVersion,
} from "@langchain/langgraph-checkpoint";
import {
  BedrockAgentCoreClient,
  CreateEventCommand,
  ListEventsCommand,
  DeleteEventCommand,
  ListSessionsCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { ConfiguredRetryStrategy } from "@smithy/util-retry";

// AgentCore Memory API field constraints (from CreateEvent docs)
const SESSION_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]*$/;
const SESSION_ID_MAX = 100;
const ACTOR_ID_RE =
  /^[a-zA-Z0-9][a-zA-Z0-9-/](?::[a-zA-Z0-9-_/]+)*[a-zA-Z0-9-_/]*$/;
const ACTOR_ID_MAX = 255;

function validateSessionId(value: string, context: string): void {
  if (!SESSION_ID_RE.test(value)) {
    throw new Error(
      `Invalid ${context} "${value}": sessionId must match [a-zA-Z0-9][a-zA-Z0-9-]* ` +
        `(only alphanumeric and hyphens, must start with alphanumeric)`
    );
  }
  if (value.length > SESSION_ID_MAX) {
    throw new Error(
      `Invalid ${context} "${value}": sessionId must be at most ${SESSION_ID_MAX} characters`
    );
  }
}

function validateActorId(value: string, context: string): void {
  if (!ACTOR_ID_RE.test(value)) {
    throw new Error(
      `Invalid ${context} "${value}": actorId must match ` +
        `[a-zA-Z0-9][a-zA-Z0-9-/](?::[a-zA-Z0-9-_/]+)*[a-zA-Z0-9-_/]*`
    );
  }
  if (value.length > ACTOR_ID_MAX) {
    throw new Error(
      `Invalid ${context} "${value}": actorId must be at most ${ACTOR_ID_MAX} characters`
    );
  }
}

interface AWSError extends Error {
  name: string;
  code?: string;
  statusCode?: number;
}

interface ConfigurableConfig {
  thread_id?: string;
  actor_id?: string;
  checkpoint_id?: string;
  checkpoint_ns?: string;
  [key: string]: unknown;
}

export interface AgentCoreMemorySaverParams {
  memoryId: string;
  region?: string;
}

interface StoredCheckpoint {
  checkpoint: Checkpoint;
  metadata: CheckpointMetadata;
  parentCheckpointId?: string;
}

interface StoredWrite {
  taskId: string;
  channel: string;
  value: unknown;
}

/**
 * AWS Bedrock AgentCore Memory implementation of BaseCheckpointSaver.
 *
 * This checkpointer stores checkpoint data in AWS Bedrock AgentCore Memory,
 * reusing serialization and base functionality from @langchain/langgraph-checkpoint.
 */
export class AgentCoreMemorySaver extends BaseCheckpointSaver {
  private client: BedrockAgentCoreClient;

  private memoryId: string;

  private sessionCache: Map<string, string[]> = new Map();

  private cacheExpiry: number = 0;

  private readonly CACHE_TTL = 10000; // 10 seconds cache to reduce API calls

  private lastRequestTime = 0;

  private readonly MIN_REQUEST_INTERVAL = 60; // 60ms between requests (16.7 req/sec, under 20/sec limit)

  private defaultActorId?: string; // Unique default actor ID per instance

  // Cache of sessionId -> rootEventId (oldest main-branch event) used to
  // bootstrap new checkpoint_ns branches. Populated on first put() and
  // recovered from ListEvents on cold start.
  private sessionRootEventId: Map<string, string> = new Map();

  constructor(
    { memoryId, region }: AgentCoreMemorySaverParams,
    serde?: SerializerProtocol
  ) {
    super(serde);
    this.memoryId = memoryId;
    this.client = new BedrockAgentCoreClient({
      region,
      retryStrategy: new ConfiguredRetryStrategy(
        3, // maxAttempts
        (attempt: number) => Math.min(1000 * 2 ** attempt, 10000) // exponential backoff with max 10s
      ),
      requestHandler: new NodeHttpHandler({
        connectionTimeout: 30000,
        socketTimeout: 30000,
      }),
    });
  }

  private getSessionId(config: RunnableConfig): string | undefined {
    const sessionId = config.configurable?.thread_id;
    if (sessionId) validateSessionId(sessionId, "thread_id");
    return sessionId;
  }

  private getActorId(config: RunnableConfig): string | undefined {
    const actorId = config.configurable?.actor_id;
    if (actorId) {
      validateActorId(actorId, "actor_id");
      return actorId;
    }
    if (!this.defaultActorId) {
      // Use only alphanumeric + hyphens to satisfy actorId pattern
      this.defaultActorId = `actor-${Date.now()}-${Math.random()
        .toString(36)
        .substring(2, 11)}`;
    }
    return this.defaultActorId;
  }

  private decodeBlob(blob: string | Uint8Array | unknown): string {
    if (typeof blob === "string") {
      // Skip empty or very short strings
      if (blob.length < 4) {
        return blob;
      }

      // Check if it looks like Base64 and has proper length
      if (/^[A-Za-z0-9+/]*={0,2}$/.test(blob) && blob.length % 4 === 0) {
        try {
          const decoded = atob(blob);
          // Convert binary string back to Uint8Array
          const bytes = new Uint8Array(decoded.length);
          for (let i = 0; i < decoded.length; i++) {
            bytes[i] = decoded.charCodeAt(i);
          }
          // Use TextDecoder for proper Unicode handling
          const decoder = new TextDecoder();
          const unicodeDecoded = decoder.decode(bytes);
          // Additional validation - decoded should be reasonable length
          if (unicodeDecoded.length > 0 && unicodeDecoded.length < 1000000) {
            return unicodeDecoded;
          }
        } catch {
          // Base64 decode failed, fall through to return original
        }
      }
      return blob;
    }
    if (blob instanceof Uint8Array) {
      return new TextDecoder().decode(blob);
    }
    // Handle other potential blob formats
    return JSON.stringify(blob);
  }

  /** @internal */
  private async getAllSessionIds(actorId: string): Promise<string[]> {
    const now = Date.now();
    const cacheKey = `${this.memoryId}:${actorId}`;

    // Return cached result if still valid
    if (now < this.cacheExpiry && this.sessionCache.has(cacheKey)) {
      return this.sessionCache.get(cacheKey)!;
    }

    const sessionIds: string[] = [];
    let nextToken: string | undefined;

    try {
      do {
        await this.rateLimit();
        const response = await this.client.send(
          new ListSessionsCommand({
            memoryId: this.memoryId,
            actorId,
            maxResults: 100,
            nextToken,
          })
        );

        if (response.sessionSummaries) {
          sessionIds.push(
            ...response.sessionSummaries
              .map((session) => session.sessionId!)
              .filter(Boolean)
          );
        }

        nextToken = response.nextToken;
      } while (nextToken);

      // Cache the result
      this.sessionCache.set(cacheKey, sessionIds);
      this.cacheExpiry = now + this.CACHE_TTL;
    } catch (error) {
      // If we can't list sessions, return empty array
      return [];
    }

    return sessionIds;
  }

  /** @internal */
  private async rateLimit(): Promise<void> {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    if (timeSinceLastRequest < this.MIN_REQUEST_INTERVAL) {
      await new Promise((resolve) =>
        setTimeout(resolve, this.MIN_REQUEST_INTERVAL - timeSinceLastRequest)
      );
    }
    this.lastRequestTime = Date.now();
  }

  /** Maps checkpoint_ns to AgentCore branch name. Empty string uses "main". */
  private checkpointNsToBranch(checkpointNs: string): string {
    return checkpointNs === "" ? "main" : checkpointNs;
  }

  /**
   * Returns the rootEventId for a session, required when creating the first
   * event on a non-main branch. Recovers from API on cold start by fetching
   * the oldest event on the main branch. If no main events exist yet,
   * creates a lightweight anchor event on main to bootstrap the session.
   */
  private async getRootEventId(
    sessionId: string,
    actorId: string
  ): Promise<string> {
    if (this.sessionRootEventId.has(sessionId)) {
      return this.sessionRootEventId.get(sessionId)!;
    }

    // Cold start recovery: find the oldest event on main branch
    try {
      let oldestEventId: string | undefined;
      let nextToken: string | undefined;

      do {
        await this.rateLimit();
        const response = await this.client.send(
          new ListEventsCommand({
            memoryId: this.memoryId,
            actorId,
            sessionId,
            includePayloads: false,
            maxResults: 100,
            nextToken,
            filter: { branch: { name: "main", includeParentBranches: false } },
          })
        );
        const events = response.events || [];
        if (events.length > 0) {
          oldestEventId = events[events.length - 1].eventId;
        }
        nextToken = response.nextToken;
      } while (nextToken);

      if (oldestEventId) {
        this.sessionRootEventId.set(sessionId, oldestEventId);
        return oldestEventId;
      }
    } catch {
      // Branch not found or session empty — fall through to create anchor
    }

    // No main events exist yet — create a lightweight anchor event on main
    // to bootstrap the session so non-main branches have a rootEventId.
    await this.rateLimit();
    const res = await this.client.send(
      new CreateEventCommand({
        memoryId: this.memoryId,
        actorId,
        sessionId,
        eventTimestamp: new Date(),
        payload: [{ blob: btoa("__anchor__") }],
        metadata: { type: { stringValue: "__anchor__" } },
        // no branch field — lands on main automatically
      })
    );

    const anchorId = res.event?.eventId;
    if (!anchorId) {
      throw new Error(
        `Failed to create anchor event for session "${sessionId}"`
      );
    }
    this.sessionRootEventId.set(sessionId, anchorId);
    return anchorId;
  }

  /** @internal */
  private async querySpecificSession(
    sessionId: string,
    threadId: string,
    actorId: string | undefined,
    checkpointNs: string | undefined,
    allCheckpoints: Map<
      string,
      StoredCheckpoint & { namespace: string; threadId: string }
    >,
    allWrites: Map<string, StoredWrite[]>
  ): Promise<void> {
    let nextToken: string | undefined;
    const branchFilter = checkpointNs !== undefined
      ? { branch: { name: this.checkpointNsToBranch(checkpointNs), includeParentBranches: false } }
      : undefined;

    // Paginate through all events for this session
    do {
      try {
        await this.rateLimit();
        const response = await this.client.send(
          new ListEventsCommand({
            memoryId: this.memoryId,
            actorId,
            sessionId,
            includePayloads: true,
            maxResults: 100,
            nextToken,
            filter: branchFilter,
          })
        );

        nextToken = response.nextToken;
        const events = response.events || [];

        // Process events for this session
        for (const event of events) {
          const payload = event.payload?.[0];
          if (!payload?.blob) continue;

          try {
            const blobStr = this.decodeBlob(payload.blob);
            // Add validation before parsing
            if (!blobStr || blobStr.length < 2) {
              continue;
            }
            // Skip if it doesn't look like JSON
            if (
              !blobStr.trim().startsWith("{") &&
              !blobStr.trim().startsWith("[")
            ) {
              continue;
            }
            const data = await this.serde.loadsTyped("json", blobStr);

            if (data.type === "checkpoint") {
              const eventCheckpointNs = data.checkpoint_ns || "";
              allCheckpoints.set(data.checkpointId, {
                checkpoint: data.checkpoint,
                metadata: data.metadata,
                parentCheckpointId: data.parentCheckpointId,
                namespace: eventCheckpointNs,
                threadId,
              });
            } else if (data.type === "write") {
              const { checkpointId } = data;
              if (!allWrites.has(checkpointId)) {
                allWrites.set(checkpointId, []);
              }
              allWrites.get(checkpointId)!.push({
                taskId: data.taskId,
                channel: data.channel,
                value: data.value,
              });
            }
          } catch (error) {
            console.error(
              "Error parsing event data:",
              error,
              "Raw blob:",
              payload.blob,
              "Decoded:",
              this.decodeBlob(payload.blob)
            );
            continue;
          }
        }
      } catch (error) {
        const awsError = error as AWSError;
        const isBranchNotFound =
          awsError.name === "ValidationException" &&
          String(error).includes("Branch not found");
        if (awsError.name === "ResourceNotFoundException" || isBranchNotFound) {
          return;
        }
        throw error;
      }
    } while (nextToken);
  }

  /** @internal */
  private async _migratePendingSends(
    pendingWrites: [string, string, unknown][],
    checkpoint: Checkpoint
  ): Promise<void> {
    // Find writes to TASKS channel
    const taskWrites = pendingWrites.filter(([, channel]) => channel === TASKS);

    if (taskWrites.length > 0) {
      // Collect all task values and reverse to match expected order
      const taskValues = taskWrites.map(([, , value]) => value).reverse();

      // Add to checkpoint channel_values
      checkpoint.channel_values[TASKS] = taskValues;

      // Update channel versions
      checkpoint.channel_versions[TASKS] =
        Object.keys(checkpoint.channel_versions).length > 0
          ? maxChannelVersion(...Object.values(checkpoint.channel_versions))
          : this.getNextVersion(undefined);
    }
  }

  // @ts-expect-error - Type compatibility issues due to monorepo version mismatches
  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const threadId = config.configurable?.thread_id;

    if (!threadId) {
      return undefined;
    }

    const resolvedActorId = this.getActorId(config);
    if (!resolvedActorId) {
      throw new Error("actor_id is required");
    }

    const checkpointId = config.configurable?.checkpoint_id;
    const sessionId = this.getSessionId(config);

    if (!sessionId) {
      return undefined;
    }

    try {
      const checkpoints = new Map<string, StoredCheckpoint>();
      const writes = new Map<string, StoredWrite[]>();
      let nextToken: string | undefined;

      do {
        await this.rateLimit();
        const response = await this.client.send(
          new ListEventsCommand({
            memoryId: this.memoryId,
            actorId: resolvedActorId,
            sessionId,
            includePayloads: true,
            maxResults: 100,
            nextToken,
            filter: {
              branch: {
                name: this.checkpointNsToBranch(
                  config.configurable?.checkpoint_ns || ""
                ),
                includeParentBranches: false,
              },
            },
          })
        );

        nextToken = response.nextToken;

        // Process events to extract checkpoints and writes
        for (const event of response.events || []) {
          const payload = event.payload?.[0];
          if (!payload?.blob) continue;

          try {
            const blobStr = this.decodeBlob(payload.blob);
            if (!blobStr || blobStr.length < 2) continue;
            if (
              !blobStr.trim().startsWith("{") &&
              !blobStr.trim().startsWith("[")
            ) {
              continue;
            }
            const data = await this.serde.loadsTyped("json", blobStr);

            if (data.type === "checkpoint") {
              checkpoints.set(data.checkpointId, {
                checkpoint: data.checkpoint,
                metadata: data.metadata,
                parentCheckpointId: data.parentCheckpointId,
              });
            } else if (data.type === "write") {
              const existing = writes.get(data.checkpointId) || [];
              existing.push({
                taskId: data.taskId,
                channel: data.channel,
                value: data.value,
              });
              writes.set(data.checkpointId, existing);
            }
          } catch (error) {
            console.error(
              "Error parsing event data:",
              error,
              "Raw blob:",
              payload.blob,
              "Decoded:",
              this.decodeBlob(payload.blob)
            );
          }
        }
      } while (nextToken);

      // Find the target checkpoint
      const targetCheckpointId =
        checkpointId || Array.from(checkpoints.keys()).sort().pop();
      if (!targetCheckpointId) {
        return undefined;
      }

      const stored = checkpoints.get(targetCheckpointId);
      if (!stored) {
        return undefined;
      }

      const pendingWrites = (writes.get(targetCheckpointId) || []).map(
        (write): [string, string, unknown] => [
          write.taskId,
          write.channel,
          write.value,
        ]
      );

      const configurable: ConfigurableConfig = {
        thread_id: config.configurable?.thread_id,
        checkpoint_ns: config.configurable?.checkpoint_ns || "",
        checkpoint_id: targetCheckpointId,
      };

      // Only include actor_id if it was explicitly provided
      if (config.configurable && "actor_id" in config.configurable) {
        configurable.actor_id = resolvedActorId;
      }

      // Apply pending sends migration for older checkpoint versions
      const checkpointCopy = copyCheckpoint(stored.checkpoint);
      if (stored.checkpoint.v < 4 && stored.parentCheckpointId) {
        // Get parent checkpoint's pending writes for migration
        const parentWrites = writes.get(stored.parentCheckpointId) || [];
        const parentPendingWrites = parentWrites.map(
          (write): [string, string, unknown] => [
            write.taskId,
            write.channel,
            write.value,
          ]
        );
        await this._migratePendingSends(parentPendingWrites, checkpointCopy);
      }

      const result: CheckpointTuple = {
        config: { configurable },
        checkpoint: checkpointCopy,
        metadata: stored.metadata,
        pendingWrites,
      };

      if (stored.parentCheckpointId) {
        const parentConfigurable: ConfigurableConfig = {
          thread_id: config.configurable?.thread_id,
          checkpoint_ns: config.configurable?.checkpoint_ns || "",
          checkpoint_id: stored.parentCheckpointId,
        };

        // Only include actor_id if it was explicitly provided
        if (config.configurable && "actor_id" in config.configurable) {
          parentConfigurable.actor_id = resolvedActorId;
        }

        result.parentConfig = { configurable: parentConfigurable };
      }

      return result;
    } catch (error) {
      const awsError = error as AWSError;
      const isBranchNotFound =
        awsError.name === "ValidationException" &&
        String(error).includes("Branch not found");
      if (awsError.name === "ResourceNotFoundException" || isBranchNotFound) {
        return undefined;
      }
      console.error("Error in getTuple:", error);
      throw error;
    }
  }

  // @ts-expect-error - Type compatibility issues due to monorepo version mismatches
  async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions
  ): AsyncGenerator<CheckpointTuple> {
    const threadId = config.configurable?.thread_id;
    const checkpointNs = config.configurable?.checkpoint_ns;
    const actorId = this.getActorId(config);

    const allCheckpoints = new Map<
      string,
      StoredCheckpoint & { namespace: string; threadId: string }
    >();
    const allWrites = new Map<string, StoredWrite[]>();

    const { limit, before, filter } = options || {};

    try {
      if (threadId) {
        // Query specific session
        await this.querySpecificSession(
          threadId,
          threadId,
          actorId,
          checkpointNs,
          allCheckpoints,
          allWrites
        );
      } else {
        // When threadId is not specified, get all sessions for this actor
        const allSessionIds = await this.getAllSessionIds(actorId!);

        for (const sessionId of allSessionIds) {
          await this.querySpecificSession(
            sessionId,
            sessionId,
            actorId,
            checkpointNs,
            allCheckpoints,
            allWrites
          );
        }
      }

      // Sort checkpoints by ID in descending order
      const sortedCheckpointIds = Array.from(allCheckpoints.keys()).sort(
        (a, b) => b.localeCompare(a)
      );

      let count = 0;
      for (const checkpointId of sortedCheckpointIds) {
        if (
          before?.configurable?.checkpoint_id &&
          checkpointId >= before.configurable.checkpoint_id
        ) {
          continue;
        }

        const stored = allCheckpoints.get(checkpointId)!;

        // Filter by checkpoint_ns if specified
        if (checkpointNs !== undefined && stored.namespace !== checkpointNs) {
          continue;
        }

        // Apply metadata filter
        if (filter) {
          const matches = Object.entries(filter).every(
            ([key, value]) =>
              (stored.metadata as Record<string, unknown>)[key] === value
          );
          if (!matches) {
            continue;
          }
        }

        if (limit && count >= limit) {
          break;
        }

        const pendingWrites = (allWrites.get(checkpointId) || []).map(
          (write): [string, string, unknown] => [
            write.taskId,
            write.channel,
            write.value,
          ]
        );

        const configurable: ConfigurableConfig = {
          thread_id: stored.threadId,
          checkpoint_ns: stored.namespace,
          checkpoint_id: checkpointId,
        };

        // Only include actor_id if it was explicitly provided
        if (config.configurable && "actor_id" in config.configurable) {
          configurable.actor_id = actorId;
        }

        // Apply pending sends migration for older checkpoint versions
        const checkpointCopy = copyCheckpoint(stored.checkpoint);
        if (stored.checkpoint.v < 4 && stored.parentCheckpointId) {
          // Get parent checkpoint's pending writes for migration
          const parentWrites = allWrites.get(stored.parentCheckpointId) || [];
          const parentPendingWrites = parentWrites.map(
            (write): [string, string, unknown] => [
              write.taskId,
              write.channel,
              write.value,
            ]
          );
          await this._migratePendingSends(parentPendingWrites, checkpointCopy);
        }

        const result: CheckpointTuple = {
          config: { configurable },
          checkpoint: checkpointCopy,
          metadata: stored.metadata,
          pendingWrites,
        };

        if (stored.parentCheckpointId) {
          const parentConfigurable: ConfigurableConfig = {
            thread_id: stored.threadId,
            checkpoint_ns: stored.namespace,
            checkpoint_id: stored.parentCheckpointId,
          };

          // Only include actor_id if it was explicitly provided
          if (config.configurable && "actor_id" in config.configurable) {
            parentConfigurable.actor_id = actorId;
          }

          result.parentConfig = { configurable: parentConfigurable };
        }

        yield result;
        count++;
      }
    } catch (error) {
      console.error("Error in list:", error);
      if ((error as AWSError).name === "ResourceNotFoundException") {
        return;
      }
      throw error;
    }
  }

  // @ts-expect-error - Type compatibility issues due to monorepo version mismatches
  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    newVersions: ChannelVersions
  ): Promise<RunnableConfig> {
    const sessionId = this.getSessionId(config);
    const actorId = this.getActorId(config);

    if (!sessionId) {
      throw new Error("thread_id is required for put operation");
    }

    if (!actorId) {
      throw new Error("actor_id is required for put operation");
    }

    const checkpointCopy = copyCheckpoint(checkpoint);

    // Filter channel_values to only include changed channels based on newVersions
    if (checkpointCopy.channel_values && newVersions !== undefined) {
      if (Object.keys(newVersions).length === 0) {
        // Empty newVersions means no channels changed - store empty channel_values
        checkpointCopy.channel_values = {};
      } else {
        // Only store the channels that are in newVersions
        const filteredChannelValues: Record<string, unknown> = {};
        for (const channel of Object.keys(newVersions)) {
          if (channel in checkpointCopy.channel_values) {
            filteredChannelValues[channel] =
              checkpointCopy.channel_values[channel];
          }
        }
        checkpointCopy.channel_values = filteredChannelValues;
      }
    }

    // No migration needed for v4+ checkpoints - migration only happens in getTuple/list for older checkpoints
    const parentCheckpointId = config.configurable?.checkpoint_id;

    // Store checkpoint data with checkpoint_ns
    const checkpointData = {
      type: "checkpoint",
      checkpointId: checkpoint.id,
      checkpoint: checkpointCopy,
      metadata,
      parentCheckpointId,
      checkpoint_ns: config.configurable?.checkpoint_ns || "",
    };

    const branchName = this.checkpointNsToBranch(
      config.configurable?.checkpoint_ns || ""
    );

    try {
      const [, serializedData] = await this.serde.dumpsTyped(checkpointData);
      const dataString =
        typeof serializedData === "string"
          ? serializedData
          : new TextDecoder().decode(serializedData);
      const encoder = new TextEncoder();
      const bytes = encoder.encode(dataString);
      const binaryString = Array.from(bytes, (byte) =>
        String.fromCharCode(byte)
      ).join("");
      const blobData = btoa(binaryString);

      // For non-main branches, provide rootEventId to bootstrap the branch.
      // getRootEventId() always returns a value, creating an anchor event if needed.
      let branchInput: { name: string; rootEventId?: string } = { name: branchName };
      if (branchName !== "main") {
        branchInput.rootEventId = await this.getRootEventId(sessionId, actorId);
      }

      const res = await this.client.send(
        new CreateEventCommand({
          memoryId: this.memoryId,
          actorId,
          sessionId,
          eventTimestamp: new Date(),
          branch: branchInput,
          payload: [{ blob: blobData }],
          metadata: {
            type: { stringValue: "checkpoint" },
            checkpointId: { stringValue: checkpoint.id },
            checkpoint_ns: {
              stringValue: config.configurable?.checkpoint_ns || "",
            },
          },
        })
      );

      // Cache the first main-branch event ID as rootEventId for this session
      if (branchName === "main" && !this.sessionRootEventId.has(sessionId)) {
        const eventId = res.event?.eventId;
        if (eventId) this.sessionRootEventId.set(sessionId, eventId);
      }
    } catch (error) {
      console.error("Error storing checkpoint:", error);
      throw error;
    }

    const returnConfigurable: ConfigurableConfig = {
      thread_id: config.configurable?.thread_id,
      checkpoint_ns: config.configurable?.checkpoint_ns || "",
      checkpoint_id: checkpoint.id,
    };

    // Only include actor_id if it was explicitly provided
    if (config.configurable && "actor_id" in config.configurable) {
      returnConfigurable.actor_id = actorId;
    }

    return {
      configurable: returnConfigurable,
    };
  }

  // @ts-expect-error - Type compatibility issues due to monorepo version mismatches
  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string
  ): Promise<void> {
    const sessionId = this.getSessionId(config);
    const actorId = this.getActorId(config);
    const checkpointId = config.configurable?.checkpoint_id;

    if (!sessionId || !checkpointId) {
      throw new Error(
        "thread_id and checkpoint_id are required for putWrites operation"
      );
    }

    if (!actorId) {
      throw new Error("actor_id is required for putWrites operation");
    }

    const branchName = this.checkpointNsToBranch(
      config.configurable?.checkpoint_ns || ""
    );

    for (const [channel, value] of writes) {
      const writeData = {
        type: "write",
        checkpointId,
        taskId,
        channel,
        value,
      };

      try {
        const [, serializedData] = await this.serde.dumpsTyped(writeData);
        const dataString =
          typeof serializedData === "string"
            ? serializedData
            : new TextDecoder().decode(serializedData);
        const encoder = new TextEncoder();
        const bytes = encoder.encode(dataString);
        const binaryString = Array.from(bytes, (byte) =>
          String.fromCharCode(byte)
        ).join("");
        const blobData = btoa(binaryString);

        let branchInput: { name: string; rootEventId?: string } = { name: branchName };
        if (branchName !== "main") {
          branchInput.rootEventId = await this.getRootEventId(sessionId, actorId);
        }

        await this.client.send(
          new CreateEventCommand({
            memoryId: this.memoryId,
            actorId,
            sessionId,
            eventTimestamp: new Date(),
            branch: branchInput,
            payload: [{ blob: blobData }],
            metadata: {
              type: { stringValue: "write" },
              checkpointId: { stringValue: checkpointId },
              taskId: { stringValue: taskId },
              channel: { stringValue: channel },
              checkpoint_ns: {
                stringValue: config.configurable?.checkpoint_ns || "",
              },
            },
          })
        );
      } catch (error) {
        console.error(`Error storing write for channel ${channel}:`, error);
        throw error;
      }
    }
  }

  async deleteThread(threadId: string, actorId?: string): Promise<void> {
    const resolvedActorId = actorId || this.defaultActorId;
    if (!resolvedActorId) {
      throw new Error(
        "actor_id is required for deleteThread in AgentCore Memory"
      );
    }

    validateSessionId(threadId, "threadId");
    validateActorId(resolvedActorId, "actor_id");

    const sessionId = threadId;
    let nextToken: string | undefined;

    try {
      while (true) {
        await this.rateLimit();
        const response = await this.client.send(
          new ListEventsCommand({
            memoryId: this.memoryId,
            actorId: resolvedActorId,
            sessionId,
            maxResults: 100,
            includePayloads: false,
            nextToken,
          })
        );

        if (response.events) {
          for (const event of response.events) {
            if (event.eventId) {
              try {
                await this.rateLimit();
                await this.client.send(
                  new DeleteEventCommand({
                    memoryId: this.memoryId,
                    sessionId,
                    eventId: event.eventId,
                    actorId: resolvedActorId,
                  })
                );
              } catch (error) {
                console.error(`Error deleting event ${event.eventId}:`, error);
                // Continue with other events even if one fails
              }
            }
          }
        }

        if (!response.nextToken) {
          break;
        }
        nextToken = response.nextToken;
      }
    } catch (error) {
      console.error("Error in deleteThread:", error);
      throw error;
    }
  }
}

import {
  BedrockAgentRuntimeClient,
  CreateInvocationCommand,
  CreateSessionCommand,
  GetInvocationStepCommand,
  ListInvocationStepsCommand,
  ListInvocationStepsCommandOutput,
  PutInvocationStepCommand,
} from "@aws-sdk/client-bedrock-agent-runtime";
import { RunnableConfig } from "@langchain/core/runnables";
import {
  BaseCheckpointSaver,
  ChannelVersions,
  Checkpoint,
  CheckpointMetadata,
  CheckpointTuple,
  PendingWrite,
} from "@langchain/langgraph-checkpoint";

import {
  constructCheckpointTuple,
  createSessionCheckpoint,
  deserializeData,
  generateCheckpointId,
  generateWriteId,
  getAwsConfig,
  getCheckpointId,
  isConflictException,
  isResourceNotFoundException,
  processWriteOperations,
  processWritesInvocationContentBlocks,
  transformPendingTaskWrites,
} from "./utils.js";

import { CHECKPOINT_PREFIX } from "./constants.js";
import { SessionCheckpoint, SessionPendingWrite } from "./models.js";

/**
 * Saves and retrieves checkpoints using Amazon Bedrock Agent Runtime sessions.
 * This class provides functionality to persist checkpoint data and writes to Bedrock Agent Runtime sessions.
 */
export class BedrockSessionSaver extends BaseCheckpointSaver {
  /**
   * The Bedrock Agent Runtime client
   */
  private client: BedrockAgentRuntimeClient;

  /**
   * Initialize the BedrockSessionSaver
   * @param regionName - AWS region name
   * @param credentialsProfileName - AWS credentials profile name
   * @param awsAccessKeyId - AWS access key ID
   * @param awsSecretAccessKey - AWS secret access key
   * @param awsSessionToken - AWS session token
   * @param endpointUrl - Custom endpoint URL for the Bedrock service
   * @param config - AWS SDK config object
   */
  constructor(
    regionName?: string,
    credentialsProfileName?: string,
    awsAccessKeyId?: string,
    awsSecretAccessKey?: string,
    awsSessionToken?: string,
    endpointUrl?: string
  ) {
    super();

    const clientConfig = getAwsConfig(
      regionName,
      credentialsProfileName,
      awsAccessKeyId,
      awsSecretAccessKey,
      awsSessionToken,
      endpointUrl
    );

    this.client = new BedrockAgentRuntimeClient(clientConfig);
  }

  /**
   * Create a new session
   * @returns The session ID
   */
  async createSession(sessionProps?: {
    tags?: Record<string, string>;
    encryptionKeyArn?: string;
  }): Promise<string> {
    const { tags, encryptionKeyArn } = sessionProps ?? {};

    const command = new CreateSessionCommand({ tags, encryptionKeyArn });
    const response = await this.client.send(command);
    return response.sessionId!;
  }

  /**
   * Create a new invocation if one doesn't already exist
   * @param threadId - The session identifier
   * @param invocationId - The unique invocation identifier
   */
  private async _createSessionInvocation(
    threadId: string,
    invocationId: string
  ): Promise<void> {
    try {
      const command = new CreateInvocationCommand({
        sessionIdentifier: threadId,
        invocationId,
      });

      await this.client.send(command);
    } catch (error) {
      if (isConflictException(error)) {
        return;
      }

      throw error;
    }
  }

  /**
   * Retrieve a checkpoint tuple from the Bedrock session
   */
  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    if (!config.configurable) {
      return undefined;
    }

    const threadId = String(config.configurable.thread_id || "");
    const checkpointNs = String(config.configurable.checkpoint_ns || "");
    const checkpointId = getCheckpointId(config);
    const invocationId = generateCheckpointId(checkpointNs);

    try {
      const invocationStep = await this.getCheckpointStep(
        threadId,
        invocationId,
        checkpointId
      );

      if (!invocationStep) {
        return undefined;
      }

      // Parse checkpoint data
      const stepText = invocationStep.payload?.contentBlocks?.[0].text ?? "";
      const sessionCheckpoint = JSON.parse(stepText);

      // Get pending writes
      const pendingWriteOps = await this.getCheckpointPendingWrites(
        threadId,
        checkpointNs,
        invocationStep.invocationStepId!
      );

      // Get task sends from parent checkpoint
      const taskSends = await this._getTaskSends(
        threadId,
        checkpointNs,
        sessionCheckpoint.parentCheckpointId
      );

      return await constructCheckpointTuple(
        threadId,
        checkpointNs,
        sessionCheckpoint,
        pendingWriteOps,
        taskSends,
        this.serde
      );
    } catch (error) {
      if (isResourceNotFoundException(error)) {
        return undefined;
      }
      throw error;
    }
  }

  /**
   * Store a new checkpoint in the Bedrock session
   */
  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    newVersions: ChannelVersions
  ): Promise<RunnableConfig> {
    const sessionCheckpoint = createSessionCheckpoint(
      checkpoint,
      config,
      metadata,
      newVersions
    );

    // Create session invocation to store checkpoint
    const invocationId = generateCheckpointId(sessionCheckpoint.checkpointNs);
    await this._createSessionInvocation(
      sessionCheckpoint.threadId,
      invocationId
    );

    // Store checkpoint
    const command = new PutInvocationStepCommand({
      sessionIdentifier: sessionCheckpoint.threadId,
      invocationIdentifier: invocationId,
      invocationStepId: sessionCheckpoint.checkpointId,
      invocationStepTime: new Date(),
      payload: {
        contentBlocks: [
          {
            text: JSON.stringify(sessionCheckpoint),
          },
        ],
      },
    });

    await this.client.send(command);

    return {
      configurable: {
        thread_id: sessionCheckpoint.threadId,
        checkpoint_ns: sessionCheckpoint.checkpointNs,
        checkpoint_id: checkpoint.id,
      },
    };
  }

  /**
   * Store write operations in the Bedrock session
   */
  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string
  ): Promise<void> {
    if (!config.configurable) {
      return;
    }

    const threadId = String(config.configurable.thread_id || "");
    const checkpointNs = String(config.configurable.checkpoint_ns || "");
    const checkpointId = String(config.configurable.checkpoint_id || "");

    // Generate unique identifier for this write operation
    const writesId = generateWriteId(checkpointNs, checkpointId);

    // Create new session invocation
    await this._createSessionInvocation(threadId, writesId);

    // Get existing pending writes
    const currentPendingWrites = await this.getCheckpointPendingWrites(
      threadId,
      checkpointNs,
      checkpointId
    );

    // Process writes
    const [contentBlocks, newWrites] = processWriteOperations(
      writes,
      taskId,
      currentPendingWrites,
      checkpointNs,
      checkpointId,
      this.serde
    );

    // Save content blocks if any exist
    if (contentBlocks.length > 0 && newWrites) {
      const command = new PutInvocationStepCommand({
        sessionIdentifier: threadId,
        invocationIdentifier: writesId,
        invocationStepTime: new Date(),
        payload: {
          contentBlocks,
        },
      });

      await this.client.send(command);
    }
  }

  /**
   * Get sorted task sends for parent checkpoint
   */
  private async _getTaskSends(
    threadId: string,
    checkpointNs: string,
    parentCheckpointId?: string
  ) {
    if (!parentCheckpointId) {
      console.log("No parent checkpoint id, returning empty task sends");
      return [];
    }

    try {
      const pendingWrites = await this.getCheckpointPendingWrites(
        threadId,
        checkpointNs,
        parentCheckpointId
      );

      return transformPendingTaskWrites(pendingWrites);
    } catch {
      return [];
    }
  }

  /**
   * List checkpoints matching the given criteria
   */
  async *list(
    config: RunnableConfig,
    {
      filter,
      before,
      limit,
    }: {
      filter?: Record<string, unknown>;
      before?: RunnableConfig;
      limit?: number;
    } = {}
  ): AsyncGenerator<CheckpointTuple, void, unknown> {
    if (!config.configurable) {
      return;
    }

    const threadId = String(config.configurable.thread_id || "");
    const checkpointNs = String(config.configurable.checkpoint_ns || "");
    const invocationId = generateCheckpointId(checkpointNs);

    // List all invocation steps with pagination
    const matchingCheckpoints: SessionCheckpoint[] = [];
    let nextToken: string | undefined;

    try {
      do {
        const command: ListInvocationStepsCommand =
          new ListInvocationStepsCommand({
            sessionIdentifier: threadId,
            invocationIdentifier: invocationId,
            nextToken,
          });

        const response: ListInvocationStepsCommandOutput =
          await this.client.send(command);
        nextToken = response.nextToken;

        // Process current page
        if (response.invocationStepSummaries) {
          for (const step of response.invocationStepSummaries) {
            // Skip if before filter applies
            if (
              before &&
              step.invocationStepId &&
              before.configurable?.checkpoint_id &&
              step.invocationStepId >= String(before.configurable.checkpoint_id)
            ) {
              continue;
            }

            // Get full step details
            const getCommand = new GetInvocationStepCommand({
              sessionIdentifier: threadId,
              invocationIdentifier: step.invocationId,
              invocationStepId: step.invocationStepId,
            });

            const stepDetail = await this.client.send(getCommand);

            if (!stepDetail.invocationStep?.payload?.contentBlocks?.[0]?.text) {
              continue;
            }

            try {
              const sessionCheckpoint = JSON.parse(
                stepDetail.invocationStep.payload.contentBlocks[0].text
              );

              // Skip non-checkpoint steps
              if (sessionCheckpoint.stepType !== CHECKPOINT_PREFIX) {
                continue;
              }

              // Apply metadata filter
              if (filter && sessionCheckpoint.metadata) {
                const metadata = (await deserializeData(
                  this.serde,
                  sessionCheckpoint.metadata
                )) as Record<string, unknown>;
                if (
                  !Object.entries(filter).every(([k, v]) => metadata[k] === v)
                ) {
                  continue;
                }
              }

              // Append checkpoints
              matchingCheckpoints.push(sessionCheckpoint);

              if (limit && matchingCheckpoints.length >= limit) {
                nextToken = undefined;
                break;
              }
            } catch {
              // Skip steps with invalid JSON
              continue;
            }
          }
        }
      } while (nextToken);
    } catch (error) {
      if (isResourceNotFoundException(error)) {
        return undefined;
      }
      throw error;
    }

    // Yield checkpoint tuples
    for (const checkpoint of matchingCheckpoints) {
      const pendingWriteOps = await this.getCheckpointPendingWrites(
        threadId,
        checkpoint.checkpointNs,
        checkpoint.checkpointId
      );

      const taskSends = checkpoint.parentCheckpointId
        ? await this._getTaskSends(
            threadId,
            checkpoint.checkpointNs,
            checkpoint.parentCheckpointId
          )
        : [];

      yield constructCheckpointTuple(
        threadId,
        checkpoint.checkpointNs,
        checkpoint,
        pendingWriteOps,
        taskSends,
        this.serde
      );
    }
  }

  private async getCheckpointStep(
    threadId: string,
    invocationId: string,
    checkpointId?: string
  ) {
    if (!checkpointId) {
      return this.findMostRecentCheckpointStep(threadId, invocationId);
    }

    const step = await this.client.send(
      new GetInvocationStepCommand({
        sessionIdentifier: threadId,
        invocationIdentifier: invocationId,
        invocationStepId: checkpointId,
      })
    );

    return step.invocationStep;
  }

  private async findMostRecentCheckpointStep(
    threadId: string,
    invocationId: string
  ) {
    let nextToken;

    do {
      const command: ListInvocationStepsCommand =
        new ListInvocationStepsCommand({
          sessionIdentifier: threadId,
          invocationIdentifier: invocationId,
          nextToken,
        });

      const invocationSteps = await this.client.send(command);
      nextToken = invocationSteps.nextToken;

      // Process current page
      if (!invocationSteps.invocationStepSummaries?.length) {
        return undefined;
      }

      for (const step of invocationSteps.invocationStepSummaries) {
        const { invocationStep } = await this.client.send(
          new GetInvocationStepCommand({
            sessionIdentifier: threadId,
            invocationIdentifier: step.invocationId,
            invocationStepId: step.invocationStepId,
          })
        );

        if (!invocationStep?.payload?.contentBlocks?.[0]?.text) {
          continue;
        }

        const payload = JSON.parse(
          invocationStep.payload.contentBlocks[0].text
        );

        if (payload.stepType === CHECKPOINT_PREFIX) {
          return invocationStep;
        }
      }
    } while (nextToken);

    return undefined;
  }

  /**
   * Get pending writes for a checkpoint
   */
  private async getCheckpointPendingWrites(
    threadId: string,
    checkpointNs: string,
    checkpointId: string
  ): Promise<SessionPendingWrite[]> {
    const writesId = generateWriteId(checkpointNs, checkpointId);

    try {
      // First list to get the step ID
      const listCommand = new ListInvocationStepsCommand({
        sessionIdentifier: threadId,
        invocationIdentifier: writesId,
        maxResults: 1,
      });

      const { invocationStepSummaries } = await this.client.send(listCommand);

      if (!invocationStepSummaries?.length) {
        return [];
      }

      // Then get the specific step using the retrieved invocationStepId
      const getCommand = new GetInvocationStepCommand({
        sessionIdentifier: threadId,
        invocationIdentifier: writesId,
        invocationStepId: invocationStepSummaries[0].invocationStepId,
      });

      const step = await this.client.send(getCommand);

      if (!step.invocationStep?.payload?.contentBlocks) {
        return [];
      }

      const contentBlocks = step.invocationStep.payload.contentBlocks.map(
        (block) => ({
          text: block.text || "",
        })
      );

      return await processWritesInvocationContentBlocks(
        contentBlocks,
        this.serde
      );
    } catch (error) {
      if (isResourceNotFoundException(error)) {
        return [];
      }
      throw error;
    }
  }
}

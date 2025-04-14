import {
  ChannelVersions,
  Checkpoint,
  CheckpointMetadata,
  CheckpointTuple,
  PendingWrite,
  SerializerProtocol,
  WRITES_IDX_MAP,
} from "@langchain/langgraph-checkpoint";
import crypto from "crypto";

import {
  ConflictException,
  ResourceNotFoundException,
} from "@aws-sdk/client-bedrock-agent-runtime";
import { CHECKPOINT_PREFIX } from "./constants.js";
import {
  BedrockSessionContentBlock,
  SessionCheckpoint,
  SessionPendingWrite,
  TransformedTaskWrite,
} from "./models.js";
import { RunnableConfig } from "@langchain/core/runnables";
import { threadId } from "worker_threads";

/**
 * Generate a deterministic UUID from a string input using MD5 hashing.
 * This ensures that the same input string always produces the same UUID,
 * while still conforming to AWS Bedrock's regex validation requirements.
 *
 * @param inputString - Input string to generate UUID from
 * @returns A UUID string that meets the regex pattern [a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}
 */
export function generateDeterministicUuid(inputString: string): string {
  // Create MD5 hash of the input string
  const md5Hash = crypto.createHash("md5").update(inputString).digest();

  // Format the hash bytes as a UUID string
  const uuid = [
    md5Hash.slice(0, 4).toString("hex"),
    md5Hash.slice(4, 6).toString("hex"),
    md5Hash.slice(6, 8).toString("hex"),
    md5Hash.slice(8, 10).toString("hex"),
    md5Hash.slice(10, 16).toString("hex"),
  ].join("-");

  return uuid;
}

/**
 * Generate a unique checkpoint ID
 * @param namespace - The checkpoint namespace
 * @returns A unique checkpoint ID
 */
export function generateCheckpointId(namespace: string): string {
  return generateDeterministicUuid(`CHECKPOINT#${namespace}`);
}

/**
 * Generate a unique write ID that meets AWS Bedrock's regex requirements
 * @param namespace - The checkpoint namespace
 * @param checkpointId - The checkpoint ID
 * @returns A UUID string that meets the regex pattern [a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}
 */
export function generateWriteId(
  namespace: string,
  checkpointId: string
): string {
  return generateDeterministicUuid(
    [`WRITES`, namespace, checkpointId].join("#")
  );
}

/**
 * Get AWS credentials configuration
 * @param regionName - AWS region name
 * @param credentialsProfileName - AWS credentials profile name
 * @param awsAccessKeyId - AWS access key ID
 * @param awsSecretAccessKey - AWS secret access key
 * @param awsSessionToken - AWS session token
 * @returns AWS client configuration
 */
export function getAwsConfig(
  regionName?: string,
  credentialsProfileName?: string,
  awsAccessKeyId?: string,
  awsSecretAccessKey?: string,
  awsSessionToken?: string,
  endpointUrl?: string
): Record<string, unknown> {
  const config: Record<string, unknown> = {};

  if (regionName) {
    config.region = regionName;
  }

  if (endpointUrl) {
    config.endpoint = endpointUrl;
  }

  // Set credentials if provided
  if (awsAccessKeyId && awsSecretAccessKey) {
    config.credentials = {
      accessKeyId: awsAccessKeyId,
      secretAccessKey: awsSecretAccessKey,
    };

    if (awsSessionToken) {
      (config.credentials as Record<string, unknown>).sessionToken =
        awsSessionToken;
    }
  } else if (credentialsProfileName) {
    config.credentials = {
      profile: credentialsProfileName,
    };
  }

  return config;
}

/**
 * Create a session checkpoint
 * @param checkpoint - The checkpoint data
 * @param config - The runnable config
 * @param metadata - The checkpoint metadata
 * @param serde - The serializer protocol
 * @param newVersions - The new channel versions
 * @returns A session checkpoint
 */
export function createSessionCheckpoint(
  checkpoint: Checkpoint,
  config: RunnableConfig,
  metadata: CheckpointMetadata,
  newVersions: ChannelVersions
): SessionCheckpoint {
  // Safely extract values from config
  const configurable = config.configurable || {};

  // Use type inference with default values
  const threadId = configurable.thread_id ?? "";
  const checkpointNs = configurable.checkpoint_ns ?? "";
  const parentCheckpointId = configurable.checkpoint_id;

  const checkpointId = checkpoint.id;

  const serializedCheckpoint = JSON.stringify(checkpoint);
  const serializedMetadata = metadata ? JSON.stringify(metadata) : undefined;

  return {
    stepType: CHECKPOINT_PREFIX,
    threadId,
    checkpointNs,
    checkpointId,
    parentCheckpointId,
    checkpoint: serializedCheckpoint,
    metadata: serializedMetadata,
    channelValues: JSON.stringify(checkpoint.channel_values),
    version: JSON.stringify(newVersions),
  };
}

/**
 * Process write operations
 * @param writes - The writes to process
 * @param taskId - The task ID
 * @param currentPendingWrites - The current pending writes
 * @param serde - The serializer protocol
 * @returns Tuple of content blocks and new writes
 */
export function processWriteOperations(
  writes: PendingWrite[],
  taskId: string,
  currentPendingWrites: SessionPendingWrite[],
  checkpointNs: string,
  checkpointId: string,
  serde: SerializerProtocol
): [BedrockSessionContentBlock[], boolean] {
  // // Create a map of existing writes by channel
  // const existingWritesByChannel = new Map<string, SessionPendingWrite>();
  // for (const write of currentPendingWrites) {
  //   existingWritesByChannel.set(write.taskId, write.writeIdx);
  // }

  // Process new writes
  let newWrites = false;
  const contentBlocks: BedrockSessionContentBlock[] = [];

  const currentWritesDic = currentPendingWrites.reduce<
    Record<string, SessionPendingWrite>
  >((prev, curr) => {
    // eslint-disable-next-line no-param-reassign
    prev[`${curr.taskId}_${curr.writeIdx}`] = curr;

    return prev;
  }, {});

  for (const [index, [channel, value]] of writes.entries()) {
    const writeIdx = WRITES_IDX_MAP[channel];

    let pendingWrite;

    if (writeIdx >= 0 && currentWritesDic[`${taskId}_${writeIdx}`]) {
      pendingWrite = currentWritesDic[`${taskId}_${writeIdx}`];
    } else {
      newWrites = true;

      const [valueType, serializedValue] = serde.dumpsTyped(value);
      pendingWrite = {
        threadId,
        taskId,
        channel,
        value: new TextDecoder().decode(serializedValue),
        valueType,
        writeIdx: index,
        stepType: "WRITES",
        checkpointNs,
        checkpointId,
      };
    }

    const contentBlock: BedrockSessionContentBlock = {
      text: JSON.stringify(pendingWrite),
    };

    contentBlocks.push(contentBlock);
  }

  return [contentBlocks, newWrites];
}

/**
 * Process writes invocation content blocks
 * @param contentBlocks - The content blocks to process
 * @param serde - The serializer protocol
 * @returns Array of session pending writes
 */
export async function processWritesInvocationContentBlocks(
  contentBlocks: BedrockSessionContentBlock[],
  serde: SerializerProtocol
): Promise<SessionPendingWrite[]> {
  const pendingWrites: SessionPendingWrite[] = [];

  for (const block of contentBlocks) {
    try {
      const data = JSON.parse(block.text || "");

      const pendingWrite: SessionPendingWrite = {
        taskId: data.taskId,
        channel: data.channel,
        value: await deserializeData(serde, data.value, data.valueType),
        writeIdx: data.writeIdx,
        stepType: data.stepType,
        checkpointNs: data.checkpointNs,
        checkpointId: data.checkpointId,
      };

      pendingWrites.push(pendingWrite);
    } catch (error: unknown) {
      console.error("Error processing content block:", error);
    }
  }

  return pendingWrites;
}

/**
 * Transform pending task writes
 * @param pendingWrites - The pending writes to transform
 * @returns Array of transformed writes sorted by task_path (checkpointNs), taskId, and writeIdx
 */
export function transformPendingTaskWrites(
  pendingWrites: SessionPendingWrite[],
): TransformedTaskWrite[] {
  // Import TASKS constant from langgraph
  const TASKS = '__pregel_tasks';

  // Filter writes to only include TASKS channel
  const taskWrites = pendingWrites.filter(write => write.channel === TASKS);

  // Transform to structured format with all required fields
  const result: TransformedTaskWrite[] = taskWrites.map(write => ({
    taskId: write.taskId,
    channel: write.channel,
    value: write.value,
    taskPath: write.checkpointNs, // Using checkpointNs as task_path equivalent
    writeIdx: write.writeIdx,
  }));

  // Sort by task_path (checkpointNs), taskId, and writeIdx
  result.sort((a, b) => {
    // Compare task_path (checkpointNs)
    if (a.taskPath < b.taskPath) return -1;
    if (a.taskPath > b.taskPath) return 1;

    // Compare taskId
    if (a.taskId < b.taskId) return -1;
    if (a.taskId > b.taskId) return 1;

    // Compare writeIdx
    return a.writeIdx - b.writeIdx;
  });

  return result;
}

/**
 * Get checkpoint ID from config
 * @param config - The runnable config
 * @returns The checkpoint ID
 */
export function getCheckpointId(
  config: RunnableConfig<Record<string, any>>
): string {
  if (!config.configurable) {
    return "";
  }

  const { configurable } = config;
  return String(configurable.checkpoint_id || "");
}

/**
 * Deserialize data
 * @param serde - The serializer protocol
 * @param data - The data to deserialize
 * @returns Deserialized data
 */
export async function deserializeData(
  serde: SerializerProtocol,
  data: string,
  dataType?: string
): Promise<unknown> {
  try {
    if (dataType) {
      const uint8array = new TextEncoder().encode(data);
      return await serde.loadsTyped(dataType, uint8array);
    }

    return JSON.parse(data);
  } catch (error: unknown) {
    console.error("Error deserializing data:", error);
    return {};
  }
}

/**
 * Construct checkpoint tuple
 * @param threadId - The thread ID
 * @param checkpointNs - The checkpoint namespace
 * @param sessionCheckpoint - The session checkpoint
 * @param pendingWriteOps - The pending write operations
 * @param taskSends - The task sends
 * @param serde - The serializer protocol
 * @returns A checkpoint tuple
 */
export async function constructCheckpointTuple(
  threadId: string,
  checkpointNs: string,
  sessionCheckpoint: SessionCheckpoint,
  pendingWriteOps: SessionPendingWrite[],
  sends: TransformedTaskWrite[],
  serde: SerializerProtocol
): Promise<CheckpointTuple> {
  const checkpoint = JSON.parse(sessionCheckpoint.checkpoint);
  const metadata = (await deserializeData(
    serde,
    sessionCheckpoint.metadata ?? ""
  )) as CheckpointMetadata;

  const config = {
    configurable: {
      thread_id: threadId,
      checkpoint_ns: checkpointNs,
      checkpoint_id: sessionCheckpoint.checkpointId,
    },
  };

  const parentConfig = sessionCheckpoint.parentCheckpointId
    ? {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: checkpointNs,
        checkpoint_id: sessionCheckpoint.parentCheckpointId,
      },
    }
    : undefined;

  const pendingWrites = pendingWriteOps.map(
    (write) =>
      [write.taskId, write.channel, write.value] as [string, string, unknown]
  );

  return {
    config,
    checkpoint: {
      ...checkpoint,
      pending_sends: await Promise.all(
        sends.map(
          async (send) => await deserializeData(serde, String(send.value))
        )
      ),
      channel_values: await deserializeData(
        serde,
        sessionCheckpoint.channelValues ?? ""
      ),
    },
    metadata,
    parentConfig,
    pendingWrites,
  };
}

/**
 * Type guard for ConflictException
 * @param error - The error to check
 * @returns boolean indicating if the error is a ConflictException
 */
export function isConflictException(
  error: unknown
): error is ConflictException {
  return Boolean(
    error &&
    typeof error === "object" &&
    "name" in error &&
    error.name === "ConflictException"
  );
}

/**
 * Type guard for ResourceNotFoundException
 * @param error - The error to check
 * @returns boolean indicating if the error is a ResourceNotFoundException
 */
export function isResourceNotFoundException(
  error: unknown
): error is ResourceNotFoundException {
  return Boolean(
    error &&
    typeof error === "object" &&
    "name" in error &&
    error.name === "ResourceNotFoundException"
  );
}

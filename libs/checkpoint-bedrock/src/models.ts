/**
 * Content block for Bedrock session
 */
export interface BedrockSessionContentBlock {
  /**
   * Text content
   */
  text: string;
}

/**
 * Checkpoint data stored in a session
 */
export interface SessionCheckpoint {
  /**
   * Type of step (always "checkpoint")
   */
  stepType: string;

  /**
   * Thread identifier
   */
  threadId: string;

  /**
   * Checkpoint namespace
   */
  checkpointNs: string;

  /**
   * Checkpoint identifier
   */
  checkpointId: string;

  /**
   * Parent checkpoint identifier
   */
  parentCheckpointId?: string;

  /**
   * Serialized checkpoint data
   */
  checkpoint: string;

  /**
   * Serialized metadata
   */
  metadata?: string;

  /**
   * Channel versions
   */
  version?: string;

  channelValues?: string;
}

/**
 * Pending write operation
 */
export interface SessionPendingWrite {
  /**
   * Task identifier
   */
  taskId: string;

  /**
   * Channel
   */
  channel: string;

  /**
   * Value
   */
  value: unknown;

  /**
   * Write index
   */
  writeIdx: number;

  stepType: string;

  checkpointNs: string;

  checkpointId: string;
}

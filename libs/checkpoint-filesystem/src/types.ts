import {
  Checkpoint,
  CheckpointMetadata,
} from "@langchain/langgraph-checkpoint";

export interface IFileSaverStorageData {
  // checkpoint namespace -> checkpoint ID -> checkpoint mapping [checkpoint, metadata, parentCheckpointId]
  storage: Record<
    string,
    Record<string, [Checkpoint, CheckpointMetadata, string | undefined]>
  >;
}

export interface IFileSaverWritesData {
  // outerKey(return generateKey()) -> innerKeyStr(JSON.stringify([taskId,channel_idx|idx])) -> [taskId, channel, value(any)]
  writes: Record<string, Record<string, [string, string, unknown]>>;
}

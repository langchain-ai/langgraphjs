import {
  Checkpoint,
  CheckpointMetadata,
} from "@langchain/langgraph-checkpoint";

export interface IFileSaverStorageData {
  // checkpoint namespace -> checkpoint ID -> checkpoint mapping [checkpoint, metadata, parentCheckpointId]
  // 支持序列化后的数据 (Uint8Array 或 string) 或原始数据
  storage: Record<
    string,
    Record<
      string,
      [
        Checkpoint | Uint8Array | string,
        CheckpointMetadata | Uint8Array | string,
        string | undefined
      ]
    >
  >;
}

export interface IFileSaverWritesData {
  // outerKey(return generateKey()) -> innerKeyStr(JSON.stringify([taskId,channel_idx|idx])) -> [taskId, channel, value(any)]
  writes: Record<string, Record<string, [string, string, unknown]>>;
}

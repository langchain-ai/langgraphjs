import { expect } from "@jest/globals";
import { mergeConfigs, RunnableConfig } from "@langchain/core/runnables";
import {
  BaseCheckpointSaver,
  CheckpointTuple,
  PendingWrite,
} from "@langchain/langgraph-checkpoint";

export async function* putTuples(
  saver: BaseCheckpointSaver,
  generatedTuples: {
    tuple: CheckpointTuple;
    writes: { writes: PendingWrite[]; taskId: string }[];
    newVersions: Record<string, number | string>;
  }[],
  initializerConfig: RunnableConfig
): AsyncGenerator<CheckpointTuple> {
  for (const generated of generatedTuples) {
    const { thread_id, checkpoint_ns } = generated.tuple.config
      .configurable as { thread_id: string; checkpoint_ns: string };

    const checkpoint_id = generated.tuple.parentConfig?.configurable
      ?.checkpoint_id as string | undefined;

    const config = mergeConfigs(initializerConfig, {
      configurable: {
        thread_id,
        checkpoint_ns,
        checkpoint_id,
      },
    });

    const existingTuple = await saver.getTuple(
      mergeConfigs(initializerConfig, generated.tuple.config)
    );

    expect(existingTuple).toBeUndefined();

    const newConfig = await saver.put(
      config,
      generated.tuple.checkpoint,
      generated.tuple.metadata!,
      generated.newVersions
    );

    for (const write of generated.writes) {
      await saver.putWrites(newConfig, write.writes, write.taskId);
    }

    const expectedTuple = await saver.getTuple(newConfig);

    expect(expectedTuple).not.toBeUndefined();

    if (expectedTuple) {
      yield expectedTuple;
    }
  }
}

export async function toArray(
  generator: AsyncGenerator<CheckpointTuple>
): Promise<CheckpointTuple[]> {
  const result = [];
  for await (const item of generator) {
    result.push(item);
  }
  return result;
}

export function toMap(tuples: CheckpointTuple[]): Map<string, CheckpointTuple> {
  const result = new Map<string, CheckpointTuple>();
  for (const item of tuples) {
    const key = item.checkpoint.id;
    result.set(key, item);
  }
  return result;
}

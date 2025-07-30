import {
  emptyCheckpoint,
  type CheckpointMetadata,
  type BaseCheckpointSaver,
} from "@langchain/langgraph-checkpoint";
import { CheckpointerTestInitializer } from "../types.js";

export function deleteThreadTests<T extends BaseCheckpointSaver>(
  initializer: CheckpointerTestInitializer<T>
) {
  describe(`${initializer.checkpointerName}#deleteThread`, () => {
    let checkpointer: T;
    beforeAll(async () => {
      checkpointer = await initializer.createCheckpointer();
    });

    afterAll(async () => {
      await initializer.destroyCheckpointer?.(checkpointer);
    });

    it("should delete thread", async () => {
      const thread1 = { configurable: { thread_id: "1", checkpoint_ns: "" } };
      const thread2 = { configurable: { thread_id: "2", checkpoint_ns: "" } };

      const meta: CheckpointMetadata = {
        source: "update",
        step: -1,
        parents: {},
      };

      await checkpointer.put(thread1, emptyCheckpoint(), meta, {});
      await checkpointer.put(thread2, emptyCheckpoint(), meta, {});

      expect(await checkpointer.getTuple(thread1)).toBeDefined();

      await checkpointer.deleteThread("1");

      expect(await checkpointer.getTuple(thread1)).toBeUndefined();
      expect(await checkpointer.getTuple(thread2)).toBeDefined();
    });
  });
}

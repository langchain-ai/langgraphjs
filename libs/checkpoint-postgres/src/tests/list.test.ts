import { expect, it, vi } from "vitest";
import pg from "pg";
import { emptyCheckpoint } from "@langchain/langgraph-checkpoint";
import { PostgresSaver } from "../index.js";

it("loads only the requested history row's blobs and writes", async () => {
  const query = vi
    .fn()
    .mockResolvedValueOnce({
      rows: ["first", "second"].map((checkpoint_id) => ({
        thread_id: "thread",
        checkpoint_ns: "",
        checkpoint_id,
        parent_checkpoint_id: null,
        checkpoint: emptyCheckpoint(),
        metadata: {},
      })),
    })
    .mockResolvedValue({ rows: [] });
  const saver = new PostgresSaver({ query } as unknown as pg.Pool);
  const history = saver.list({ configurable: { thread_id: "thread" } });
  expect((await history.next()).value?.config.configurable?.checkpoint_id).toBe(
    "first"
  );
  expect(query).toHaveBeenCalledTimes(3);
  await history.return(undefined);
  expect(query).toHaveBeenCalledTimes(3);
});

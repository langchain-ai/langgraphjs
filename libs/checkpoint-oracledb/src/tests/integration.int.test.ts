import { describe, expect, test } from "vitest";
import { config } from "dotenv";

import { OracleCheckpointSaver } from "../saver.js";
import { OracleStore } from "../store.js";
import {
  TASKS,
  type Checkpoint,
  type CheckpointMetadata,
  type IndexConfig,
} from "@langchain/langgraph-checkpoint";

config();

const { ORACLE_USER, ORACLE_PASSWORD, ORACLE_CONNECT_STRING } = process.env;
const hasOracleCredentials =
  ORACLE_USER && ORACLE_PASSWORD && ORACLE_CONNECT_STRING;

const tablePrefix =
  process.env.ORACLE_LANGGRAPH_TABLE_PREFIX ??
  `LG_TEST_${Date.now().toString(36).toUpperCase()}_`;

const oracleConnection = {
  user: ORACLE_USER,
  password: ORACLE_PASSWORD,
  connectString: ORACLE_CONNECT_STRING,
};

const describeIfOracle = hasOracleCredentials ? describe : describe.skip;

function checkpoint(id: string): Checkpoint {
  return {
    v: 4,
    id,
    ts: new Date().toISOString(),
    channel_values: {
      state: { step: id },
    },
    channel_versions: {
      state: 1,
    },
    versions_seen: {},
  };
}

const metadata: CheckpointMetadata = {
  source: "loop",
  step: 1,
  parents: {},
};

const testEmbeddings = {
  async embedDocuments(texts: string[]): Promise<number[][]> {
    return texts.map((text) =>
      text.toLowerCase().includes("fruit") ||
      text.toLowerCase().includes("apple")
        ? [1, 0]
        : [0, 1]
    );
  },
  async embedQuery(text: string): Promise<number[]> {
    return text.toLowerCase().includes("fruit") ||
      text.toLowerCase().includes("apple")
      ? [1, 0]
      : [0, 1];
  },
};

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}

describeIfOracle("Oracle integration", () => {
  test("runs checkpoint put/getTuple/list/putWrites/deleteThread", async () => {
    const saver = new OracleCheckpointSaver({
      connection: oracleConnection,
      tablePrefix,
    });
    const threadId = `thread-${Date.now()}`;

    await saver.setup();
    const savedConfig = await saver.put(
      { configurable: { thread_id: threadId } },
      checkpoint("checkpoint-1"),
      metadata,
      { state: 1 }
    );

    await saver.putWrites(savedConfig, [["events", { ok: true }]], "task-1");

    const tuple = await saver.getTuple(savedConfig);
    expect(tuple?.checkpoint.id).toBe("checkpoint-1");
    expect(tuple?.pendingWrites).toEqual([
      ["task-1", "events", { ok: true }],
    ]);

    const listed = [];
    for await (const item of saver.list({
      configurable: { thread_id: threadId },
    })) {
      listed.push(item);
    }
    expect(listed.map((item) => item.checkpoint.id)).toContain(
      "checkpoint-1"
    );

    await saver.deleteThread(threadId);
    await expect(saver.getTuple(savedConfig)).resolves.toBeUndefined();
    await saver.end();
  });

  test("keeps empty checkpoint namespace distinct from user namespace", async () => {
    const saver = new OracleCheckpointSaver({
      connection: oracleConnection,
      tablePrefix,
    });
    const threadId = `namespace-${Date.now()}`;
    const collisionNs = "__langgraph_empty_checkpoint_ns__";

    const defaultConfig = await saver.put(
      { configurable: { thread_id: threadId, checkpoint_ns: "" } },
      checkpoint("default-ns"),
      metadata,
      { state: 1 }
    );
    const collisionConfig = await saver.put(
      { configurable: { thread_id: threadId, checkpoint_ns: collisionNs } },
      checkpoint("literal-ns"),
      metadata,
      { state: 1 }
    );

    await expect(saver.getTuple(defaultConfig)).resolves.toMatchObject({
      checkpoint: { id: "default-ns" },
      config: { configurable: { checkpoint_ns: "" } },
    });
    await expect(saver.getTuple(collisionConfig)).resolves.toMatchObject({
      checkpoint: { id: "literal-ns" },
      config: { configurable: { checkpoint_ns: collisionNs } },
    });

    await saver.deleteThread(threadId);
    await saver.end();
  });

  test("uses deep metadata containment for list filters", async () => {
    const saver = new OracleCheckpointSaver({
      connection: oracleConnection,
      tablePrefix,
    });
    const threadId = `metadata-${Date.now()}`;
    await saver.put(
      { configurable: { thread_id: threadId } },
      checkpoint("metadata-1"),
      {
        ...metadata,
        nested: { a: 1, b: { c: true } },
      } as CheckpointMetadata,
      { state: 1 }
    );

    const matches = await collect(
      saver.list(
        { configurable: { thread_id: threadId } },
        { filter: { nested: { b: { c: true } } } }
      )
    );
    expect(matches.map((item) => item.checkpoint.id)).toEqual(["metadata-1"]);

    const limited = await collect(
      saver.list(
        { configurable: { thread_id: threadId } },
        { filter: { source: "loop" }, limit: 0 }
      )
    );
    expect(limited).toEqual([]);

    await saver.deleteThread(threadId);
    await saver.end();
  });

  test("hydrates legacy pending sends from parent checkpoint TASKS writes", async () => {
    const saver = new OracleCheckpointSaver({
      connection: oracleConnection,
      tablePrefix,
    });
    const threadId = `pending-sends-${Date.now()}`;
    const parent = checkpoint("parent");
    parent.v = 3;
    const child = checkpoint("child");
    child.v = 3;

    const parentConfig = await saver.put(
      { configurable: { thread_id: threadId } },
      parent,
      metadata,
      { state: 1 }
    );
    await saver.putWrites(parentConfig, [[TASKS, { resume: true }]], "task-send");
    const childConfig = await saver.put(
      parentConfig,
      child,
      metadata,
      { state: 1 }
    );

    const tuple = await saver.getTuple(childConfig);
    expect(tuple?.checkpoint.channel_values[TASKS]).toEqual([
      { resume: true },
    ]);

    await saver.deleteThread(threadId);
    await saver.end();
  });

  test("handles concurrent checkpoint puts and duplicate writes idempotently", async () => {
    const saver = new OracleCheckpointSaver({
      connection: oracleConnection,
      tablePrefix,
    });
    const threadId = `concurrent-${Date.now()}`;
    const config = {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: "",
      },
    };
    const cp = checkpoint("concurrent-checkpoint");

    try {
      const savedConfigs = await Promise.all(
        Array.from({ length: 5 }, () =>
          saver.put(config, cp, metadata, { state: 1 })
        )
      );

      expect(
        savedConfigs.every(
          (savedConfig) =>
            savedConfig.configurable?.checkpoint_id === cp.id &&
            savedConfig.configurable?.thread_id === threadId
        )
      ).toBe(true);

      await Promise.all(
        savedConfigs.map((savedConfig) =>
          saver.putWrites(
            savedConfig,
            [["events", { duplicate: true }]],
            "duplicate-task"
          )
        )
      );

      const tuple = await saver.getTuple(savedConfigs[0]);
      expect(tuple?.checkpoint).toEqual(cp);
      expect(tuple?.pendingWrites).toEqual([
        ["duplicate-task", "events", { duplicate: true }],
      ]);
    } finally {
      await saver.deleteThread(threadId);
      await saver.end();
    }
  });

  test("fails with clear validation errors before Oracle string limits", async () => {
    const saver = new OracleCheckpointSaver({
      connection: oracleConnection,
      tablePrefix,
    });
    const store = new OracleStore({
      connection: oracleConnection,
      tablePrefix,
    });

    try {
      await expect(
        saver.put(
          { configurable: { thread_id: "t".repeat(513) } },
          checkpoint("too-long-thread"),
          metadata,
          { state: 1 }
        )
      ).rejects.toThrow("Oracle checkpoint thread_id exceeds 512 bytes");

      await expect(
        store.put(["limits"], "k".repeat(1025), { ok: true })
      ).rejects.toThrow("OracleStore key exceeds 1024 bytes");

      await expect(
        store.put(["n".repeat(3999)], "key", { ok: true })
      ).rejects.toThrow("OracleStore namespace path exceeds 4000 bytes");
    } finally {
      await saver.end();
      await store.stop();
    }
  });

  test("runs store put/get/search/listNamespaces/delete", async () => {
    const store = new OracleStore({
      connection: oracleConnection,
      tablePrefix,
    });
    const namespace = ["memories", `user-${Date.now()}`];

    await store.put(namespace, "profile", {
      name: "Ada",
      score: 10,
    });

    await expect(store.get(namespace, "profile")).resolves.toMatchObject({
      key: "profile",
      namespace,
      value: { name: "Ada", score: 10 },
    });

    await expect(
      store.search(["memories"], { filter: { score: { $gte: 5 } } })
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "profile",
          namespace,
        }),
      ])
    );

    await expect(
      store.listNamespaces({ prefix: ["memories"], maxDepth: 1 })
    ).resolves.toEqual(expect.arrayContaining([["memories"]]));

    await store.delete(namespace, "profile");
    await expect(store.get(namespace, "profile")).resolves.toBeNull();
    await store.stop();
  });

  test("runs store vector indexing and query search", async () => {
    const store = new OracleStore({
      connection: oracleConnection,
      tablePrefix,
      index: {
        dims: 2,
        embeddings: testEmbeddings as IndexConfig["embeddings"],
        fields: ["text"],
      },
    });
    const namespace = ["vector-memories", `user-${Date.now()}`];

    await store.put(namespace, "fruit", {
      text: "apple fruit",
      kind: "food",
    });
    await store.put(namespace, "database", {
      text: "oracle database",
      kind: "tech",
    });

    const results = await store.search(namespace, {
      query: "fruit",
      limit: 2,
    });

    expect(results[0]).toMatchObject({
      key: "fruit",
      namespace,
      value: { text: "apple fruit", kind: "food" },
    });
    expect(results[0].score).toBeGreaterThan(results[1].score ?? -Infinity);

    await store.delete(namespace, "fruit");
    await store.delete(namespace, "database");
    await store.stop();
  });
});

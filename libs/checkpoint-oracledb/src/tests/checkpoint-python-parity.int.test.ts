// Copyright (c) 2026, Oracle and/or its affiliates.
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { config } from "dotenv";
import oracledb from "oracledb";
import { beforeEach, describe, expect, test } from "vitest";

import {
  ERROR,
  INTERRUPT,
  type Checkpoint,
  type CheckpointMetadata,
  type CheckpointTuple,
} from "@langchain/langgraph-checkpoint";

import { OracleCheckpointSaver } from "../saver.js";
import { getOracleCheckpointTables } from "../sql.js";

config();

const { ORACLE_USER, ORACLE_PASSWORD, ORACLE_CONNECT_STRING } = process.env;
const hasOracleCredentials =
  ORACLE_USER && ORACLE_PASSWORD && ORACLE_CONNECT_STRING;

const tablePrefix =
  process.env.ORACLE_LANGGRAPH_TABLE_PREFIX ??
  `LG_PY_PARITY_${Date.now().toString(36).toUpperCase()}_`;

const oracleConnection = {
  user: ORACLE_USER,
  password: ORACLE_PASSWORD,
  connectString: ORACLE_CONNECT_STRING,
};

const describeIfOracle = hasOracleCredentials ? describe : describe.skip;

function uniqueCheckpointPrefix(label: string): string {
  return `LG_${label}_${Date.now().toString(36).toUpperCase()}_${Math.random()
    .toString(36)
    .slice(2, 8)
    .toUpperCase()}_`;
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}

async function dropCheckpointTables(prefix: string): Promise<void> {
  const tables = getOracleCheckpointTables(prefix);
  const connection = await oracledb.getConnection(oracleConnection);
  try {
    for (const tableName of [
      tables.checkpoint_writes,
      tables.checkpoint_blobs,
      tables.checkpoints,
      tables.checkpoint_migrations,
    ]) {
      try {
        await connection.execute(`DROP TABLE ${tableName} PURGE`);
      } catch (error) {
        const code = (error as { errorNum?: number }).errorNum;
        if (code !== 942) throw error;
      }
    }
    await connection.commit();
  } finally {
    await connection.close();
  }
}

function threadId(label: string): string {
  return `${label}-${randomUUID()}`;
}

function fixedCheckpointId(sequence: number): Checkpoint["id"] {
  return `00000000-0000-4000-8000-${sequence
    .toString()
    .padStart(12, "0")}` as Checkpoint["id"];
}

function checkpoint(
  id: Checkpoint["id"] = randomUUID() as Checkpoint["id"],
  channelValues: Record<string, unknown> = {},
  channelVersions: Record<string, number | string> = {}
): Checkpoint {
  return {
    v: 4,
    id,
    ts: new Date().toISOString(),
    channel_values: channelValues,
    channel_versions: channelVersions,
    versions_seen: {},
  };
}

function metadata(step = 0): CheckpointMetadata {
  return {
    source: "loop",
    step,
    parents: {},
  };
}

function expectBytesEqual(actual: unknown, expected: Uint8Array): void {
  expect(actual).toBeInstanceOf(Uint8Array);
  expect(
    Buffer.compare(Buffer.from(actual as Uint8Array), Buffer.from(expected))
  ).toBe(0);
}

async function withSaver<T>(
  callback: (
    saver: OracleCheckpointSaver,
    trackThread: (id: string) => string
  ) => Promise<T>
): Promise<T> {
  const saver = new OracleCheckpointSaver({
    connection: oracleConnection,
    tablePrefix,
  });
  const threads = new Set<string>();
  const trackThread = (id: string) => {
    threads.add(id);
    return id;
  };

  try {
    return await callback(saver, trackThread);
  } finally {
    try {
      for (const id of threads) {
        await saver.deleteThread(id);
      }
    } finally {
      await saver.end();
    }
  }
}

async function createCarryOverCheckpoints(
  saver: OracleCheckpointSaver,
  trackThread: (id: string) => string,
  checkpointNs: string
): Promise<{
  child: CheckpointTuple | undefined;
  latest: CheckpointTuple | undefined;
}> {
  const id = trackThread(threadId("carry-over"));
  const parentId = fixedCheckpointId(7001);
  const childId = fixedCheckpointId(7002);
  const parent = await saver.put(
    { configurable: { thread_id: id, checkpoint_ns: checkpointNs } },
    checkpoint(
      parentId,
      {
        messages: ["hi"],
        stepCount: 1,
      },
      {
        messages: 1,
        stepCount: 1,
      }
    ),
    metadata(0),
    {
      messages: 1,
      stepCount: 1,
    }
  );

  const child = await saver.put(
    parent,
    checkpoint(
      childId,
      {
        messages: ["hi"],
        stepCount: 3,
      },
      {
        messages: 1,
        stepCount: 2,
      }
    ),
    metadata(1),
    { stepCount: 2 }
  );

  return {
    child: await saver.getTuple(child),
    latest: await saver.getTuple({
      configurable: { thread_id: id, checkpoint_ns: checkpointNs },
    }),
  };
}

describeIfOracle("Oracle checkpoint Python parity", () => {
  test("handles concurrent setup calls on the same saver instance", async () => {
    const prefix = uniqueCheckpointPrefix("SETUP");
    const saver = new OracleCheckpointSaver({
      connection: oracleConnection,
      tablePrefix: prefix,
    });

    try {
      await Promise.all(Array.from({ length: 4 }, () => saver.setup()));
      const diagnostics = await saver.getDiagnostics();
      expect(diagnostics.status).toBe("ready");
    } finally {
      await saver.end();
      await dropCheckpointTables(prefix);
    }
  });

  test("handles concurrent setup from separate saver instances", async () => {
    const prefix = uniqueCheckpointPrefix("SETUP_RACE");
    const savers = Array.from(
      { length: 4 },
      () =>
        new OracleCheckpointSaver({
          connection: oracleConnection,
          tablePrefix: prefix,
        })
    );

    const results = await Promise.allSettled(
      savers.map((saver) => saver.setup())
    );

    try {
      expect(results).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ status: "fulfilled" }),
          expect.objectContaining({ status: "fulfilled" }),
          expect.objectContaining({ status: "fulfilled" }),
          expect.objectContaining({ status: "fulfilled" }),
        ])
      );
      const diagnostics = await savers[0].getDiagnostics();
      expect(diagnostics.status).toBe("ready");
    } finally {
      await Promise.allSettled(savers.map((saver) => saver.end()));
      await dropCheckpointTables(prefix);
    }
  });

  test("preserves checkpoint channel bytes and empty blob markers", async () => {
    await withSaver(async (saver, trackThread) => {
      const bytes = new Uint8Array([1, 2, 3, 4, 5]);
      const saved = await saver.put(
        { configurable: { thread_id: trackThread(threadId("channel-bytes")) } },
        checkpoint(
          fixedCheckpointId(1001),
          {
            bytes,
            kept: "value",
          },
          {
            bytes: "v1",
            kept: "v3",
            removed: "v4",
          }
        ),
        metadata(),
        {
          bytes: "v1",
          kept: "v3",
          removed: "v4",
        }
      );

      const loaded = await saver.getTuple(saved);
      expectBytesEqual(loaded?.checkpoint.channel_values.bytes, bytes);
      expect(loaded?.checkpoint.channel_values.kept).toBe("value");
      expect(loaded?.checkpoint.channel_values.removed).toBeUndefined();
      expect(loaded?.checkpoint.channel_versions.removed).toBe("v4");
    });
  });

  test("preserves empty and large checkpoint channel bytes", async () => {
    await withSaver(async (saver, trackThread) => {
      const emptyBytes = new Uint8Array();
      const largeBytes = new Uint8Array(32768).fill(121);
      const saved = await saver.put(
        {
          configurable: {
            thread_id: trackThread(threadId("large-channel-bytes")),
          },
        },
        checkpoint(
          fixedCheckpointId(1002),
          {
            empty_bytes: emptyBytes,
            large_bytes: largeBytes,
            kept: "value",
          },
          {
            empty_bytes: "v1",
            large_bytes: "v2",
            kept: "v3",
            removed: "v4",
          }
        ),
        metadata(),
        {
          empty_bytes: "v1",
          large_bytes: "v2",
          kept: "v3",
          removed: "v4",
        }
      );

      const loaded = await saver.getTuple(saved);
      expectBytesEqual(
        loaded?.checkpoint.channel_values.empty_bytes,
        emptyBytes
      );
      expectBytesEqual(
        loaded?.checkpoint.channel_values.large_bytes,
        largeBytes
      );
      expect(loaded?.checkpoint.channel_values.kept).toBe("value");
      expect(loaded?.checkpoint.channel_values.removed).toBeUndefined();
      expect(loaded?.checkpoint.channel_versions.removed).toBe("v4");
    });
  });

  test("persists checkpoint history across saver instances", async () => {
    const id = threadId("session-history");
    const firstCheckpointId = fixedCheckpointId(2001);
    const secondCheckpointId = fixedCheckpointId(2002);
    const firstSaver = new OracleCheckpointSaver({
      connection: oracleConnection,
      tablePrefix,
    });
    const secondSaver = new OracleCheckpointSaver({
      connection: oracleConnection,
      tablePrefix,
    });

    try {
      const first = await firstSaver.put(
        { configurable: { thread_id: id } },
        checkpoint(
          firstCheckpointId,
          { messages: [{ type: "human", content: "first" }] },
          { messages: "v1" }
        ),
        {
          ...metadata(0),
          source: "loop",
          test_source: "session_test",
          writes: { test_key: "first" },
        } as CheckpointMetadata,
        { messages: "v1" }
      );
      await firstSaver.put(
        first,
        checkpoint(
          secondCheckpointId,
          { messages: [{ type: "human", content: "second" }] },
          { messages: "v2" }
        ),
        {
          ...metadata(1),
          source: "loop",
          test_source: "session_test",
          writes: { test_key: "second" },
        } as CheckpointMetadata,
        { messages: "v2" }
      );
      await firstSaver.end();

      const latest = await secondSaver.getTuple({
        configurable: { thread_id: id },
      });
      expect(latest?.checkpoint.id).toBe(secondCheckpointId);
      expect(latest?.metadata).toMatchObject({
        source: "loop",
        test_source: "session_test",
        step: 1,
        writes: { test_key: "second" },
      });

      const history = await collect(
        secondSaver.list({ configurable: { thread_id: id } }, { limit: 10 })
      );
      expect(history.map((item) => item.checkpoint.id)).toEqual([
        secondCheckpointId,
        firstCheckpointId,
      ]);
    } finally {
      try {
        await secondSaver.deleteThread(id);
      } finally {
        await firstSaver.end();
        await secondSaver.end();
      }
    }
  });

  test("filters checkpoint list by boolean, numeric, null, and checkpoint_id", async () => {
    await withSaver(async (saver, trackThread) => {
      const id = trackThread(threadId("list-filter-edge"));
      const firstCheckpointId = fixedCheckpointId(3001);
      const secondCheckpointId = fixedCheckpointId(3002);
      const thirdCheckpointId = fixedCheckpointId(3003);
      const missingCheckpointId = fixedCheckpointId(3999);
      const specs = [
        {
          checkpoint: checkpoint(firstCheckpointId),
          metadata: {
            ...metadata(0),
            source: "input",
            flag: true,
            score: 7,
            optional: null,
          } as CheckpointMetadata,
        },
        {
          checkpoint: checkpoint(secondCheckpointId),
          metadata: {
            ...metadata(1),
            source: "loop",
            flag: false,
            score: 42,
            optional: "present",
            details: { nested: "value" },
          } as CheckpointMetadata,
        },
        {
          checkpoint: checkpoint(thirdCheckpointId),
          metadata: {
            ...metadata(2),
            source: "update",
            flag: true,
            score: 0,
            optional: "present",
          } as CheckpointMetadata,
        },
      ];

      for (const spec of specs) {
        await saver.put(
          { configurable: { thread_id: id } },
          spec.checkpoint,
          spec.metadata,
          {}
        );
      }

      await expect(
        collect(
          saver.list(
            { configurable: { thread_id: id } },
            { filter: { flag: false } }
          )
        )
      ).resolves.toEqual([
        expect.objectContaining({
          checkpoint: expect.objectContaining({ id: secondCheckpointId }),
        }),
      ]);
      await expect(
        collect(
          saver.list(
            { configurable: { thread_id: id } },
            { filter: { score: 0 } }
          )
        )
      ).resolves.toEqual([
        expect.objectContaining({
          checkpoint: expect.objectContaining({ id: thirdCheckpointId }),
        }),
      ]);
      await expect(
        collect(
          saver.list(
            { configurable: { thread_id: id } },
            { filter: { optional: null } }
          )
        )
      ).resolves.toEqual([
        expect.objectContaining({
          checkpoint: expect.objectContaining({ id: firstCheckpointId }),
        }),
      ]);
      await expect(
        collect(
          saver.list(
            { configurable: { thread_id: id } },
            { filter: { details: { nested: "value" } } }
          )
        )
      ).resolves.toEqual([
        expect.objectContaining({
          checkpoint: expect.objectContaining({ id: secondCheckpointId }),
        }),
      ]);
      await expect(
        collect(
          saver.list({
            configurable: {
              thread_id: id,
              checkpoint_id: secondCheckpointId,
            },
          })
        )
      ).resolves.toEqual([
        expect.objectContaining({
          checkpoint: expect.objectContaining({ id: secondCheckpointId }),
        }),
      ]);
      await expect(
        collect(
          saver.list({
            configurable: {
              thread_id: id,
              checkpoint_id: missingCheckpointId,
            },
          })
        )
      ).resolves.toEqual([]);
      await expect(
        collect(
          saver.list(
            { configurable: { thread_id: id } },
            { filter: { flag: true, score: 7 } }
          )
        )
      ).resolves.toEqual([
        expect.objectContaining({
          checkpoint: expect.objectContaining({ id: firstCheckpointId }),
        }),
      ]);
    });
  });

  test("supports concurrent independent saver sessions", async () => {
    const sessionSpecs = Array.from({ length: 5 }, (_, index) => ({
      threadId: threadId(`independent-session-${index}`),
      checkpointId: fixedCheckpointId(4001 + index),
      state: `session-${index}`,
    }));

    const reader = new OracleCheckpointSaver({
      connection: oracleConnection,
      tablePrefix,
    });

    try {
      await Promise.all(
        sessionSpecs.map(async ({ threadId: id, checkpointId, state }) => {
          const saver = new OracleCheckpointSaver({
            connection: oracleConnection,
            tablePrefix,
          });

          try {
            await saver.put(
              { configurable: { thread_id: id } },
              checkpoint(checkpointId, { state }, { state: 1 }),
              {
                ...metadata(0),
                source: "loop",
                test_source: "session_test",
                session: state,
              } as CheckpointMetadata,
              { state: 1 }
            );
          } finally {
            await saver.end();
          }
        })
      );

      for (const { threadId: id, checkpointId, state } of sessionSpecs) {
        await expect(
          reader.getTuple({ configurable: { thread_id: id } })
        ).resolves.toMatchObject({
          checkpoint: {
            id: checkpointId,
            channel_values: { state },
          },
          metadata: {
            source: "loop",
            test_source: "session_test",
            session: state,
          },
        });
      }
    } finally {
      try {
        for (const { threadId: id } of sessionSpecs) {
          await reader.deleteThread(id);
        }
      } finally {
        await reader.end();
      }
    }
  });

  describe.each(["root", "child"])(
    "channels carried over from an ancestor checkpoint in %s namespace",
    (namespace) => {
      const checkpointNs = namespace === "root" ? "" : namespace;
      let child: CheckpointTuple | undefined;
      let latest: CheckpointTuple | undefined;

      beforeEach(async () => {
        await withSaver(async (saver, trackThread) => {
          ({ child, latest } = await createCarryOverCheckpoints(
            saver,
            trackThread,
            checkpointNs
          ));
        });
      });

      test("reconstructs channels written by an ancestor but not the latest node", () => {
        expect(child?.checkpoint.channel_values).toEqual({
          messages: ["hi"],
          stepCount: 3,
        });
      });

      test("reconstructs carried-over channels when loading the latest checkpoint", () => {
        expect(latest?.checkpoint.channel_values).toEqual({
          messages: ["hi"],
          stepCount: 3,
        });
      });
    }
  );

  test("supports a caller supplied Oracle connection pool", async () => {
    const pool = await oracledb.createPool({
      user: ORACLE_USER!,
      password: ORACLE_PASSWORD!,
      connectString: ORACLE_CONNECT_STRING!,
      min: 1,
      max: 2,
      increment: 1,
    });
    const saver = new OracleCheckpointSaver({
      pool,
      tablePrefix,
    });
    const id = threadId("external-pool");

    try {
      const saved = await saver.put(
        { configurable: { thread_id: id } },
        checkpoint(fixedCheckpointId(5001), { state: "pool" }, { state: 1 }),
        metadata(),
        { state: 1 }
      );

      await expect(saver.getTuple(saved)).resolves.toMatchObject({
        checkpoint: { id: fixedCheckpointId(5001) },
      });
    } finally {
      try {
        await saver.deleteThread(id);
        await saver.end();
      } finally {
        await pool.close(0);
      }
    }
  });

  test("preserves multiple pending writes for the same task", async () => {
    await withSaver(async (saver, trackThread) => {
      const saved = await saver.put(
        {
          configurable: {
            thread_id: trackThread(threadId("writes-same-task")),
          },
        },
        checkpoint(),
        metadata(),
        {}
      );
      const taskId = randomUUID();
      const writes = [
        ["ch1", "v1"],
        ["ch2", "v2"],
        ["ch3", "v3"],
      ] as [string, string][];

      await saver.putWrites(saved, writes, taskId);

      const loaded = await saver.getTuple(saved);
      expect(loaded?.pendingWrites).toHaveLength(3);
      for (const [channel, value] of writes) {
        expect(loaded?.pendingWrites).toContainEqual([taskId, channel, value]);
      }
    });
  });

  test("preserves concurrent pending writes from different tasks", async () => {
    await withSaver(async (saver, trackThread) => {
      const saved = await saver.put(
        {
          configurable: {
            thread_id: trackThread(threadId("concurrent-writes")),
          },
        },
        checkpoint(),
        metadata(),
        {}
      );
      const writeSpecs = Array.from(
        { length: 6 },
        (_, index) => [randomUUID(), `val-${index}`] as const
      );

      await Promise.all(
        writeSpecs.map(([taskId, value]) =>
          saver.putWrites(saved, [["ch", value]], taskId)
        )
      );

      const loaded = await saver.getTuple(saved);
      expect(loaded?.pendingWrites).toHaveLength(writeSpecs.length);
      const actualWrites = (loaded?.pendingWrites ?? [])
        .map((write) => JSON.stringify(write))
        .sort();
      const expectedWrites = writeSpecs
        .map(([taskId, value]) => JSON.stringify([taskId, "ch", value]))
        .sort();
      expect(actualWrites).toEqual(expectedWrites);
    });
  });

  test("preserves binary pending writes", async () => {
    await withSaver(async (saver, trackThread) => {
      const saved = await saver.put(
        { configurable: { thread_id: trackThread(threadId("binary-writes")) } },
        checkpoint(),
        metadata(),
        {}
      );
      const taskId = randomUUID();
      const bytes = new Uint8Array([1, 2, 3, 4, 5]);

      await saver.putWrites(saved, [["bytes", bytes]], taskId);

      const loaded = await saver.getTuple(saved);
      const valuesByChannel = new Map(
        (loaded?.pendingWrites ?? [])
          .filter(([writeTaskId]) => writeTaskId === taskId)
          .map(([, channel, value]) => [channel, value])
      );

      expect(valuesByChannel.get("bytes")).toBeInstanceOf(Uint8Array);
      expectBytesEqual(valuesByChannel.get("bytes"), bytes);
    });
  });

  test("preserves empty and large binary pending writes", async () => {
    await withSaver(async (saver, trackThread) => {
      const saved = await saver.put(
        {
          configurable: {
            thread_id: trackThread(threadId("large-binary-writes")),
          },
        },
        checkpoint(),
        metadata(),
        {}
      );
      const taskId = randomUUID();
      const emptyBytes = new Uint8Array();
      const largeBytes = new Uint8Array(32768).fill(120);

      await saver.putWrites(
        saved,
        [
          ["empty_bytes", emptyBytes],
          ["large_bytes", largeBytes],
        ],
        taskId
      );

      const loaded = await saver.getTuple(saved);
      const valuesByChannel = new Map(
        (loaded?.pendingWrites ?? [])
          .filter(([writeTaskId]) => writeTaskId === taskId)
          .map(([, channel, value]) => [channel, value])
      );

      expect(valuesByChannel.get("empty_bytes")).toBeInstanceOf(Uint8Array);
      expectBytesEqual(valuesByChannel.get("empty_bytes"), emptyBytes);
      expect(valuesByChannel.get("large_bytes")).toBeInstanceOf(Uint8Array);
      expectBytesEqual(valuesByChannel.get("large_bytes"), largeBytes);
    });
  });

  test("preserves special write channels", async () => {
    await withSaver(async (saver, trackThread) => {
      const saved = await saver.put(
        {
          configurable: { thread_id: trackThread(threadId("special-writes")) },
        },
        checkpoint(),
        metadata(),
        {}
      );
      const taskId = randomUUID();

      await saver.putWrites(
        saved,
        [
          [ERROR, "something went wrong"],
          [INTERRUPT, { reason: "human_input" }],
        ],
        taskId
      );

      const loaded = await saver.getTuple(saved);
      expect(loaded?.pendingWrites).toContainEqual([
        taskId,
        ERROR,
        "something went wrong",
      ]);
      expect(loaded?.pendingWrites).toContainEqual([
        taskId,
        INTERRUPT,
        { reason: "human_input" },
      ]);
    });
  });

  test("isolates pending writes across checkpoint namespaces", async () => {
    await withSaver(async (saver, trackThread) => {
      const id = trackThread(threadId("namespace-writes"));
      const root = await saver.put(
        { configurable: { thread_id: id, checkpoint_ns: "" } },
        checkpoint(),
        metadata(),
        {}
      );
      const child = await saver.put(
        { configurable: { thread_id: id, checkpoint_ns: "child:1" } },
        checkpoint(),
        metadata(),
        {}
      );
      const rootTask = randomUUID();
      const childTask = randomUUID();

      await saver.putWrites(root, [["ch", "root_val"]], rootTask);
      await saver.putWrites(child, [["ch", "child_val"]], childTask);

      const rootLoaded = await saver.getTuple(root);
      const childLoaded = await saver.getTuple(child);
      expect(rootLoaded?.pendingWrites).toEqual([[rootTask, "ch", "root_val"]]);
      expect(childLoaded?.pendingWrites).toEqual([
        [childTask, "ch", "child_val"],
      ]);
    });
  });

  test("does not carry pending writes onto the next checkpoint", async () => {
    await withSaver(async (saver, trackThread) => {
      const id = trackThread(threadId("writes-next-checkpoint"));
      const first = await saver.put(
        { configurable: { thread_id: id } },
        checkpoint(),
        metadata(0),
        {}
      );
      await saver.putWrites(first, [["ch", "old_write"]], randomUUID());

      const second = await saver.put(first, checkpoint(), metadata(1), {});

      const loaded = await saver.getTuple(second);
      expect(loaded?.pendingWrites ?? []).toEqual([]);
    });
  });

  test("deleteThread removes checkpoints from all namespaces", async () => {
    await withSaver(async (saver, trackThread) => {
      const id = trackThread(threadId("delete-namespaces"));
      for (const checkpointNs of ["", "child:1"]) {
        await saver.put(
          { configurable: { thread_id: id, checkpoint_ns: checkpointNs } },
          checkpoint(),
          metadata(),
          {}
        );
      }

      await expect(
        saver.getTuple({ configurable: { thread_id: id, checkpoint_ns: "" } })
      ).resolves.toBeDefined();
      await expect(
        saver.getTuple({
          configurable: { thread_id: id, checkpoint_ns: "child:1" },
        })
      ).resolves.toBeDefined();

      await saver.deleteThread(id);

      await expect(
        saver.getTuple({ configurable: { thread_id: id, checkpoint_ns: "" } })
      ).resolves.toBeUndefined();
      await expect(
        saver.getTuple({
          configurable: { thread_id: id, checkpoint_ns: "child:1" },
        })
      ).resolves.toBeUndefined();
    });
  });

  test("deleteThread preserves unrelated threads", async () => {
    await withSaver(async (saver, trackThread) => {
      const deletedThreadId = trackThread(threadId("delete-one"));
      const preservedThreadId = trackThread(threadId("delete-preserve"));
      const preservedCheckpointId = fixedCheckpointId(6001);

      await saver.put(
        { configurable: { thread_id: deletedThreadId } },
        checkpoint(fixedCheckpointId(6000), { state: "delete" }, { state: 1 }),
        metadata(),
        { state: 1 }
      );
      await saver.put(
        { configurable: { thread_id: preservedThreadId } },
        checkpoint(preservedCheckpointId, { state: "preserve" }, { state: 1 }),
        metadata(),
        { state: 1 }
      );

      await saver.deleteThread(deletedThreadId);

      await expect(
        saver.getTuple({ configurable: { thread_id: deletedThreadId } })
      ).resolves.toBeUndefined();
      await expect(
        saver.getTuple({ configurable: { thread_id: preservedThreadId } })
      ).resolves.toMatchObject({
        checkpoint: {
          id: preservedCheckpointId,
          channel_values: { state: "preserve" },
        },
      });
    });
  });

  test("deleteThread is a no-op for a missing thread", async () => {
    await withSaver(async (saver) => {
      await expect(
        saver.deleteThread(threadId("missing"))
      ).resolves.toBeUndefined();
    });
  });
});

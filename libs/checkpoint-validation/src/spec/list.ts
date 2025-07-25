import {
  type Checkpoint,
  type CheckpointTuple,
  type BaseCheckpointSaver,
  type PendingWrite,
  uuid6,
  TASKS,
} from "@langchain/langgraph-checkpoint";
import { RunnableConfig } from "@langchain/core/runnables";
import { CheckpointerTestInitializer } from "../types.js";
import {
  generateTuplePairs,
  it_skipForSomeModules,
  putTuples,
  toArray,
  toMap,
} from "../test_utils.js";

interface ListTestCase {
  description: string;
  thread_id: string | undefined;
  checkpoint_ns: string | undefined;
  limit: number | undefined;
  before: RunnableConfig | undefined;
  filter: Record<string, unknown> | undefined;
  expectedCheckpointIds: string[];
}

/**
 * Exercises the `list` method of the checkpointer.
 *
 * IMPORTANT NOTE: This test relies on the `getTuple` method of the checkpointer functioning properly. If you have
 * failures in `getTuple`, you should fix them before addressing the failures in this test.
 *
 * @param initializer the initializer for the checkpointer
 */
export function listTests<T extends BaseCheckpointSaver>(
  initializer: CheckpointerTestInitializer<T>
) {
  const invalidThreadId = uuid6(-3);

  const namespaces = ["", "child"];

  const generatedTuples: {
    tuple: CheckpointTuple;
    writes: { writes: PendingWrite[]; taskId: string }[];
    newVersions: Record<string, number | string>;
  }[] = Array.from(generateTuplePairs(2, namespaces));

  const argumentRanges = setupArgumentRanges(
    generatedTuples.map(({ tuple }) => tuple),
    namespaces
  );

  const argumentCombinations: ListTestCase[] = Array.from(
    buildArgumentCombinations(
      argumentRanges,
      generatedTuples.map(({ tuple }) => tuple)
    )
  );

  describe(`${initializer.checkpointerName}#list`, () => {
    let checkpointer: T;
    const storedTuples: Map<string, CheckpointTuple> = new Map();

    beforeAll(async () => {
      checkpointer = await initializer.createCheckpointer();

      // put all the tuples
      for await (const tuple of putTuples(checkpointer, generatedTuples)) {
        storedTuples.set(tuple.checkpoint.id, tuple);
      }
    });

    afterAll(async () => {
      await initializer.destroyCheckpointer?.(checkpointer);
    });

    // can't reference argumentCombinations directly here because it isn't built at the time this is evaluated.
    // We do know how many entries there will be though, so we just pass the index for each entry, instead.
    it.each(argumentCombinations)(
      "$description",
      async ({
        thread_id,
        checkpoint_ns,
        limit,
        before,
        filter,
        expectedCheckpointIds,
      }: ListTestCase) => {
        const actualTuplesArray = await toArray(
          checkpointer.list(
            { configurable: { thread_id, checkpoint_ns } },
            { limit, before, filter }
          )
        );

        const limitEnforced =
          limit !== undefined && limit < expectedCheckpointIds.length;

        const expectedCount = limitEnforced
          ? limit
          : expectedCheckpointIds.length;

        expect(actualTuplesArray.length).toEqual(expectedCount);

        const actualTuplesMap = toMap(actualTuplesArray);
        const expectedTuples = expectedCheckpointIds.map(
          (tupleId) => storedTuples.get(tupleId)!
        );

        const expectedTuplesMap = toMap(expectedTuples);

        if (limitEnforced) {
          for (const tuple of actualTuplesArray) {
            expect(expectedTuplesMap.has(tuple.checkpoint.id)).toBeTruthy();
            expect(tuple).toEqual(expectedTuplesMap.get(tuple.checkpoint.id));
          }
        } else {
          expect(actualTuplesMap.size).toEqual(expectedTuplesMap.size);
          for (const [key, value] of actualTuplesMap.entries()) {
            // TODO: MongoDBSaver doesn't return pendingWrites on list, so we need to special case them
            // see: https://github.com/langchain-ai/langgraphjs/issues/589
            const checkpointerIncludesPendingWritesOnList =
              initializer.checkpointerName !==
              "@langchain/langgraph-checkpoint-mongodb";

            const expectedTuple = expectedTuplesMap.get(key);
            if (!checkpointerIncludesPendingWritesOnList) {
              delete expectedTuple?.pendingWrites;
            }

            expect(value).toEqual(expectedTuple);
          }
        }
      }
    );

    it_skipForSomeModules(initializer.checkpointerName, {
      "@langchain/langgraph-checkpoint-mongodb":
        "MongoDBSaver never stored pending sends",
    })("should migrate pending sends", async () => {
      let config: RunnableConfig = {
        configurable: { thread_id: "thread-1", checkpoint_ns: "" },
      };

      const checkpoint0: Checkpoint = {
        v: 1,
        id: uuid6(0),
        ts: "2024-04-19T17:19:07.952Z",
        channel_values: {},
        channel_versions: {},
        versions_seen: {},
      };

      config = await checkpointer.put(
        config,
        checkpoint0,
        { source: "loop", parents: {}, step: 0 },
        {}
      );

      await checkpointer.putWrites(
        config,
        [
          [TASKS, "send-1"],
          [TASKS, "send-2"],
        ],
        "task-1"
      );
      await checkpointer.putWrites(config, [[TASKS, "send-3"]], "task-2");

      // check that fetching checkpount 0 doesn't attach pending sends
      // (they should be attached to the next checkpoint)
      const tuple0 = await checkpointer.getTuple(config);
      expect(tuple0?.checkpoint.channel_values).toEqual({});
      expect(tuple0?.checkpoint.channel_versions).toEqual({});

      // create second checkpoint
      const checkpoint1: Checkpoint = {
        v: 1,
        id: uuid6(1),
        ts: "2024-04-20T17:19:07.952Z",
        channel_values: {},
        channel_versions: checkpoint0.channel_versions,
        versions_seen: checkpoint0.versions_seen,
      };
      config = await checkpointer.put(
        config,
        checkpoint1,
        { source: "loop", parents: {}, step: 1 },
        {}
      );

      // check that #list properly migrates old version of checkpoints (v < 4)
      const checkpointTupleGenerator = checkpointer.list({
        configurable: { thread_id: "thread-1" },
      });
      const checkpointTuples: CheckpointTuple[] = [];
      for await (const checkpoint of checkpointTupleGenerator) {
        checkpointTuples.push(checkpoint);
      }

      expect.soft(checkpointTuples.length).toBe(2);
      expect.soft(checkpointTuples[0].checkpoint.channel_values).toEqual({
        [TASKS]: ["send-1", "send-2", "send-3"],
      });
      expect
        .soft(checkpointTuples[0].checkpoint.channel_versions[TASKS])
        .toBeDefined();
    });
  });

  function setupArgumentRanges(
    generatedTuples: CheckpointTuple[],
    namespaces: string[]
  ): {
    thread_id: (string | undefined)[];
    checkpoint_ns: (string | undefined)[];
    limit: (number | undefined)[];
    before: (RunnableConfig | undefined)[];
    filter: (Record<string, unknown> | undefined)[];
  } {
    const parentTupleInDefaultNamespace = generatedTuples[0];
    const childTupleInDefaultNamespace = generatedTuples[1];
    const parentTupleInChildNamespace = generatedTuples[2];
    const childTupleInChildNamespace = generatedTuples[3];

    return {
      thread_id: [
        undefined,
        parentTupleInDefaultNamespace.config.configurable?.thread_id,
        childTupleInDefaultNamespace.config.configurable?.thread_id,
        parentTupleInChildNamespace.config.configurable?.thread_id,
        childTupleInChildNamespace.config.configurable?.thread_id,
        invalidThreadId,
      ],
      checkpoint_ns: [undefined, ...namespaces],
      limit: [undefined, 1, 2],
      before: [
        undefined,
        parentTupleInDefaultNamespace.config,
        childTupleInDefaultNamespace.config,
      ],
      filter:
        // TODO: MongoDBSaver support for filter is broken and can't be fixed without a breaking change
        // see: https://github.com/langchain-ai/langgraphjs/issues/581
        initializer.checkpointerName ===
        "@langchain/langgraph-checkpoint-mongodb"
          ? [undefined]
          : [undefined, {}, { source: "input" }, { source: "loop" }],
    };
  }

  function* buildArgumentCombinations(
    argumentRanges: ReturnType<typeof setupArgumentRanges>,
    allTuples: CheckpointTuple[]
  ): Generator<ListTestCase> {
    for (const thread_id of argumentRanges.thread_id) {
      for (const checkpoint_ns of argumentRanges.checkpoint_ns) {
        for (const limit of argumentRanges.limit) {
          for (const before of argumentRanges.before) {
            for (const filter of argumentRanges.filter) {
              const expectedCheckpointIds = allTuples
                .filter(
                  (tuple) =>
                    (thread_id === undefined ||
                      tuple.config.configurable?.thread_id === thread_id) &&
                    (checkpoint_ns === undefined ||
                      tuple.config.configurable?.checkpoint_ns ===
                        checkpoint_ns) &&
                    (before === undefined ||
                      tuple.checkpoint.id <
                        before.configurable?.checkpoint_id) &&
                    (filter === undefined ||
                      Object.entries(filter).every(
                        ([key, value]) =>
                          (
                            tuple.metadata as
                              | Record<string, unknown>
                              | undefined
                          )?.[key] === value
                      ))
                )
                .map((tuple) => tuple.checkpoint.id);

              yield {
                description: describeArguments(
                  argumentRanges,
                  allTuples.length,
                  {
                    thread_id,
                    checkpoint_ns,
                    limit,
                    before,
                    filter,
                    expectedCheckpointIds,
                  }
                ),
                thread_id,
                checkpoint_ns,
                limit,
                before,
                filter,
                expectedCheckpointIds,
              };
            }
          }
        }
      }
    }
  }

  function describeArguments(
    argumentRanges: ReturnType<typeof setupArgumentRanges>,
    totalTupleCount: number,
    {
      thread_id,
      checkpoint_ns,
      limit,
      before,
      filter,
      expectedCheckpointIds,
    }: Omit<ListTestCase, "description">
  ) {
    const parentTupleBeforeConfig = argumentRanges.before[1];
    const childTupleBeforeConfig = argumentRanges.before[2];

    let descriptionTupleCount: string;

    if (limit !== undefined && limit < expectedCheckpointIds.length) {
      descriptionTupleCount = `${limit} ${limit === 1 ? "tuple" : "tuples"}`;
    } else if (expectedCheckpointIds.length === totalTupleCount) {
      descriptionTupleCount = "all tuples";
    } else if (expectedCheckpointIds.length === 0) {
      descriptionTupleCount = "no tuples";
    } else {
      descriptionTupleCount = `${expectedCheckpointIds.length} tuples`;
    }

    const descriptionWhenParts: string[] = [];

    if (
      thread_id === undefined &&
      checkpoint_ns === undefined &&
      limit === undefined &&
      before === undefined &&
      filter === undefined
    ) {
      descriptionWhenParts.push("no config or options are specified");
    } else {
      if (thread_id === undefined) {
        descriptionWhenParts.push("thread_id is not specified");
      } else if (thread_id === invalidThreadId) {
        descriptionWhenParts.push(
          "thread_id does not match pushed checkpoint(s)"
        );
      } else {
        descriptionWhenParts.push(`thread_id matches pushed checkpoint(s)`);
      }

      if (checkpoint_ns === undefined) {
        descriptionWhenParts.push("checkpoint_ns is not specified");
      } else if (checkpoint_ns !== undefined && checkpoint_ns === "") {
        descriptionWhenParts.push("checkpoint_ns is the default namespace");
      } else if (checkpoint_ns !== undefined && checkpoint_ns !== "") {
        descriptionWhenParts.push(`checkpoint_ns matches '${checkpoint_ns}'`);
      }

      if (limit === undefined) {
        descriptionWhenParts.push("limit is undefined");
      } else if (limit !== undefined) {
        descriptionWhenParts.push(`limit is ${limit}`);
      }

      if (before === undefined) {
        descriptionWhenParts.push("before is not specified");
      } else if (before !== undefined && before === parentTupleBeforeConfig) {
        descriptionWhenParts.push("before parent checkpoint");
      } else if (before !== undefined && before === childTupleBeforeConfig) {
        descriptionWhenParts.push("before child checkpoint");
      }

      if (filter === undefined) {
        descriptionWhenParts.push("filter is undefined");
      } else if (Object.keys(filter).length === 0) {
        descriptionWhenParts.push("filter is an empty object");
      } else {
        for (const [key, value] of Object.entries(filter)) {
          descriptionWhenParts.push(
            `metadata.${key} matches ${JSON.stringify(value)}`
          );
        }
      }
    }

    const descriptionWhen =
      descriptionWhenParts.length > 1
        ? `${descriptionWhenParts.slice(0, -1).join(", ")}, and ${
            descriptionWhenParts[descriptionWhenParts.length - 1]
          }`
        : descriptionWhenParts[0];

    return `should return ${descriptionTupleCount} when ${descriptionWhen}`;
  }
}

import { it, expect, describe } from "vitest";
import {
  getBranchSequence,
  getMessagesMetadataMap,
  getBranchContext,
} from "./branching.js";
import { ThreadState } from "../schema.js";
import type { Message } from "../types.messages.js";

const history = [
  {
    values: {
      messages: [
        {
          content: "Fork: Hello",
          additional_kwargs: {},
          response_metadata: {},
          id: "33357aea-9c2d-4718-92f4-20038d5a2d29",
          type: "human",
        },
        {
          content: "Hey",
          additional_kwargs: {},
          response_metadata: {},
          tool_call_chunks: [],
          id: "run-782a2f90-2e39-4c21-9ee6-0f38585a0ae6",
          tool_calls: [],
          invalid_tool_calls: [],
          type: "ai",
        },
      ],
    },
    next: [],
    tasks: [],
    metadata: {
      source: "loop",
      step: 2,
      parents: {},
      thread_id: "efa80f4d-725f-4903-b19f-216309f060bc",
    },
    created_at: "2025-08-21T12:47:12.640Z",
    checkpoint: {
      thread_id: "efa80f4d-725f-4903-b19f-216309f060bc",
      checkpoint_id: "1f07e8cf-56a7-6000-8002-5e272b1d5285",
      checkpoint_ns: "",
      checkpoint_map: null,
    },
    parent_checkpoint: {
      thread_id: "efa80f4d-725f-4903-b19f-216309f060bc",
      checkpoint_id: "1f07e8cf-53aa-6d70-8001-2096b0bbf835",
      checkpoint_ns: "",
      checkpoint_map: null,
    },
  },
  {
    values: {
      messages: [
        {
          content: "Fork: Hello",
          additional_kwargs: {},
          response_metadata: {},
          id: "33357aea-9c2d-4718-92f4-20038d5a2d29",
          type: "human",
        },
      ],
    },
    next: ["agent"],
    tasks: [
      {
        id: "680ee831-4d10-50f9-956f-e0d937321614",
        name: "agent",
        error: null,
        interrupts: [],
        path: ["__pregel_pull", "agent"],
        checkpoint: null,
        state: null,
        result: {
          messages: [
            {
              content: "Hey",
              additional_kwargs: {},
              response_metadata: {},
              tool_call_chunks: [],
              id: "run-782a2f90-2e39-4c21-9ee6-0f38585a0ae6",
              tool_calls: [],
              invalid_tool_calls: [],
              type: "ai",
            },
          ],
        },
      },
    ],
    metadata: {
      source: "loop",
      step: 1,
      parents: {},
      thread_id: "efa80f4d-725f-4903-b19f-216309f060bc",
    },
    created_at: "2025-08-21T12:47:12.327Z",
    checkpoint: {
      thread_id: "efa80f4d-725f-4903-b19f-216309f060bc",
      checkpoint_id: "1f07e8cf-53aa-6d70-8001-2096b0bbf835",
      checkpoint_ns: "",
      checkpoint_map: null,
    },
    parent_checkpoint: {
      thread_id: "efa80f4d-725f-4903-b19f-216309f060bc",
      checkpoint_id: "1f07e8cf-53a8-6660-8000-f157c9cf7d66",
      checkpoint_ns: "",
      checkpoint_map: null,
    },
  },
  {
    values: { messages: [] },
    next: ["__start__"],
    tasks: [
      {
        id: "4233f4c0-5ea2-5117-9153-95e5fe59eee3",
        name: "__start__",
        error: null,
        interrupts: [],
        path: ["__pregel_pull", "__start__"],
        checkpoint: null,
        state: null,
        result: { messages: [{ type: "human", content: "Fork: Hello" }] },
      },
    ],
    metadata: {
      source: "input",
      step: 0,
      parents: {},
      thread_id: "efa80f4d-725f-4903-b19f-216309f060bc",
    },
    created_at: "2025-08-21T12:47:12.326Z",
    checkpoint: {
      thread_id: "efa80f4d-725f-4903-b19f-216309f060bc",
      checkpoint_id: "1f07e8cf-53a8-6660-8000-f157c9cf7d66",
      checkpoint_ns: "",
      checkpoint_map: null,
    },
    parent_checkpoint: {
      thread_id: "efa80f4d-725f-4903-b19f-216309f060bc",
      checkpoint_id: "1f07e8cf-4cea-6530-ffff-0995a53299c5",
      checkpoint_ns: "",
      checkpoint_map: null,
    },
  },
  {
    values: {
      messages: [
        {
          content: "Hello",
          additional_kwargs: {},
          response_metadata: {},
          id: "ec300e63-1494-4ef6-936c-60d02d7bdce1",
          type: "human",
        },
        {
          content: "Hey",
          additional_kwargs: {},
          response_metadata: {},
          tool_call_chunks: [],
          id: "run-593064bd-dd07-4ed3-99c0-a918625f4884",
          tool_calls: [],
          invalid_tool_calls: [],
          type: "ai",
        },
      ],
    },
    next: [],
    tasks: [],
    metadata: {
      source: "loop",
      step: 1,
      parents: {},
      thread_id: "efa80f4d-725f-4903-b19f-216309f060bc",
    },
    created_at: "2025-08-21T12:47:12.285Z",
    checkpoint: {
      thread_id: "efa80f4d-725f-4903-b19f-216309f060bc",
      checkpoint_id: "1f07e8cf-5344-64d0-8001-8a176e91d12f",
      checkpoint_ns: "",
      checkpoint_map: null,
    },
    parent_checkpoint: {
      thread_id: "efa80f4d-725f-4903-b19f-216309f060bc",
      checkpoint_id: "1f07e8cf-4cf8-6f90-8000-7707fd155a8a",
      checkpoint_ns: "",
      checkpoint_map: null,
    },
  },
  {
    values: {
      messages: [
        {
          content: "Hello",
          additional_kwargs: {},
          response_metadata: {},
          id: "ec300e63-1494-4ef6-936c-60d02d7bdce1",
          type: "human",
        },
        {
          content: "Hey",
          additional_kwargs: {},
          response_metadata: {},
          tool_call_chunks: [],
          id: "run-b86ef558-eaff-4838-bc03-218f20554a9f",
          tool_calls: [],
          invalid_tool_calls: [],
          type: "ai",
        },
      ],
    },
    next: [],
    tasks: [],
    metadata: {
      source: "loop",
      step: 1,
      parents: {},
      thread_id: "efa80f4d-725f-4903-b19f-216309f060bc",
    },
    created_at: "2025-08-21T12:47:11.936Z",
    checkpoint: {
      thread_id: "efa80f4d-725f-4903-b19f-216309f060bc",
      checkpoint_id: "1f07e8cf-4ff0-6400-8001-a54aedf52a76",
      checkpoint_ns: "",
      checkpoint_map: null,
    },
    parent_checkpoint: {
      thread_id: "efa80f4d-725f-4903-b19f-216309f060bc",
      checkpoint_id: "1f07e8cf-4cf8-6f90-8000-7707fd155a8a",
      checkpoint_ns: "",
      checkpoint_map: null,
    },
  },
  {
    values: {
      messages: [
        {
          content: "Hello",
          additional_kwargs: {},
          response_metadata: {},
          id: "ec300e63-1494-4ef6-936c-60d02d7bdce1",
          type: "human",
        },
      ],
    },
    next: ["agent"],
    tasks: [
      {
        id: "e3f503f1-73bc-5db1-8b4d-13f660ad1b51",
        name: "agent",
        error: null,
        interrupts: [],
        path: ["__pregel_pull", "agent"],
        checkpoint: null,
        state: null,
        result: {
          messages: [
            {
              content: "Hey",
              additional_kwargs: {},
              response_metadata: {},
              tool_call_chunks: [],
              id: "run-b86ef558-eaff-4838-bc03-218f20554a9f",
              tool_calls: [],
              invalid_tool_calls: [],
              type: "ai",
            },
          ],
        },
      },
    ],
    metadata: {
      source: "loop",
      step: 0,
      parents: {},
      thread_id: "efa80f4d-725f-4903-b19f-216309f060bc",
    },
    created_at: "2025-08-21T12:47:11.625Z",
    checkpoint: {
      thread_id: "efa80f4d-725f-4903-b19f-216309f060bc",
      checkpoint_id: "1f07e8cf-4cf8-6f90-8000-7707fd155a8a",
      checkpoint_ns: "",
      checkpoint_map: null,
    },
    parent_checkpoint: {
      thread_id: "efa80f4d-725f-4903-b19f-216309f060bc",
      checkpoint_id: "1f07e8cf-4cea-6530-ffff-0995a53299c5",
      checkpoint_ns: "",
      checkpoint_map: null,
    },
  },
  {
    values: { messages: [] },
    next: ["__start__"],
    tasks: [
      {
        id: "cddede95-d276-59f1-bc08-8051d6448734",
        name: "__start__",
        error: null,
        interrupts: [],
        path: ["__pregel_pull", "__start__"],
        checkpoint: null,
        state: null,
        result: { messages: [{ type: "human", content: "Hello" }] },
      },
    ],
    metadata: {
      source: "input",
      step: -1,
      parents: {},
      thread_id: "efa80f4d-725f-4903-b19f-216309f060bc",
    },
    created_at: "2025-08-21T12:47:11.619Z",
    checkpoint: {
      thread_id: "efa80f4d-725f-4903-b19f-216309f060bc",
      checkpoint_id: "1f07e8cf-4cea-6530-ffff-0995a53299c5",
      checkpoint_ns: "",
      checkpoint_map: null,
    },
    parent_checkpoint: null,
  },
];

const node = (
  value: ThreadState | number | undefined,
  paths: (ThreadState | number | undefined)[] = []
) => ({
  type: "node",
  value: typeof value === "number" ? history.at(value) : value,
  path: paths.map((v) => {
    if (typeof v === "number") {
      return history.at(v)?.checkpoint?.checkpoint_id;
    }
    return v?.checkpoint?.checkpoint_id;
  }),
});

const fork = (...items: unknown[]) => ({ type: "fork", items });
const sequence = (...items: unknown[]) => ({ type: "sequence", items });

it("full tree", async () => {
  const { rootSequence, paths } = getBranchSequence(history);

  expect
    .soft(paths)
    .toMatchObject(
      expect.arrayContaining(
        [[5], [5, 4], [5, 3], [2]].map((p) =>
          p.map((i) => history.at(i)?.checkpoint?.checkpoint_id)
        )
      )
    );

  expect
    .soft(rootSequence)
    .toMatchObject(
      sequence(
        node(6),
        fork(
          sequence(
            node(5, [5]),
            fork(sequence(node(4, [5, 4])), sequence(node(3, [5, 3])))
          ),
          sequence(node(2, [2]), node(1, [2]), node(0, [2]))
        )
      )
    );
});

it("partial tree", async () => {
  expect(getBranchSequence(history.slice(0, 1))).toMatchObject({
    paths: [],
    rootSequence: sequence(node(0)),
  });

  expect(getBranchSequence(history.slice(0, 2))).toMatchObject({
    paths: [],
    rootSequence: sequence(node(1), node(0)),
  });

  expect(getBranchSequence(history.slice(0, 3))).toMatchObject({
    paths: [],
    rootSequence: sequence(node(2), node(1), node(0)),
  });

  expect(getBranchSequence(history.slice(0, 4))).toMatchObject({
    paths: [],
    rootSequence: sequence(node(2), node(1), node(0)),
  });

  expect(getBranchSequence(history.slice(0, 5))).toMatchObject({
    paths: [],
    rootSequence: sequence(node(2), node(1), node(0)),
  });

  expect(getBranchSequence(history.slice(0, 6))).toMatchObject({
    paths: expect.arrayContaining(
      [[5], [5, 4], [5, 3], [2]].map((p) =>
        p.map((i) => history.at(i)?.checkpoint?.checkpoint_id)
      )
    ),
    rootSequence: sequence(
      fork(
        sequence(
          node(5, [5]),
          fork(sequence(node(4, [5, 4])), sequence(node(3, [5, 3])))
        ),
        sequence(node(2, [2]), node(1, [2]), node(0, [2]))
      )
    ),
  });

  expect(getBranchSequence(history.slice(0, 7))).toMatchObject({
    paths: expect.arrayContaining(
      [[5], [5, 4], [5, 3], [2]].map((p) =>
        p.map((i) => history.at(i)?.checkpoint?.checkpoint_id)
      )
    ),
    rootSequence: sequence(
      node(6),
      fork(
        sequence(
          node(5, [5]),
          fork(sequence(node(4, [5, 4])), sequence(node(3, [5, 3])))
        ),
        sequence(node(2, [2]), node(1, [2]), node(0, [2]))
      )
    ),
  });
});

describe("functional graph (values: null)", () => {
  type FunctionalState = Record<string, unknown>;

  const functionalHistory: ThreadState<FunctionalState>[] = [
    {
      values: {
        messages: [
          { type: "human", content: "hi", id: "m1" },
          { type: "ai", content: "hello", id: "m2" },
        ],
      },
      next: [],
      tasks: [],
      metadata: {
        source: "loop",
        step: 1,
        parents: {},
        thread_id: "t1",
      },
      created_at: "2025-01-01T00:00:02.000Z",
      checkpoint: {
        thread_id: "t1",
        checkpoint_id: "cp-2",
        checkpoint_ns: "",
        checkpoint_map: null,
      },
      parent_checkpoint: {
        thread_id: "t1",
        checkpoint_id: "cp-1",
        checkpoint_ns: "",
        checkpoint_map: null,
      },
    },
    {
      values: null as unknown as FunctionalState,
      next: [],
      tasks: [],
      metadata: {
        source: "input",
        step: 0,
        parents: {},
        thread_id: "t1",
      },
      created_at: "2025-01-01T00:00:01.000Z",
      checkpoint: {
        thread_id: "t1",
        checkpoint_id: "cp-1",
        checkpoint_ns: "",
        checkpoint_map: null,
      },
      parent_checkpoint: null,
    },
  ];

  it("getMessagesMetadataMap skips history entries with null values", () => {
    const branchContext = getBranchContext("", functionalHistory);

    const result = getMessagesMetadataMap({
      initialValues: { messages: [] },
      history: functionalHistory,
      getMessages: (values: FunctionalState) =>
        (values?.messages ?? []) as Message[],
      branchContext,
    });

    expect(result).toHaveLength(2);
    expect(result[0].messageId).toBe("m1");
    expect(result[1].messageId).toBe("m2");

    expect(result[0].firstSeenState?.checkpoint?.checkpoint_id).toBe("cp-2");
    expect(result[1].firstSeenState?.checkpoint?.checkpoint_id).toBe("cp-2");
  });
});

/**
 * Issue #2295: forkParentCheckpoint with intermediate INPUT_CP
 *
 * Models the ACTUAL server checkpoint structure where fork operations
 * create an extra INPUT checkpoint between the fork point and __start__ output.
 * Original: Root → __start__(msg) → agent(msg+resp)       [2 new CPs]
 * Fork:     Root → INPUT_CP → __start__(msg) → agent(resp) [3 new CPs]
 */
describe("issue #2295: forkParentCheckpoint with intermediate checkpoints", () => {
  function makeState(opts: {
    checkpointId: string;
    parentCheckpointId: string | null;
    messages: Array<{ type: string; content: string; id: string }>;
    step: number;
    source: string;
  }): ThreadState<Record<string, unknown>> {
    return {
      values: { messages: opts.messages },
      next: [],
      tasks: [],
      metadata: {
        source: opts.source,
        step: opts.step,
        parents: {},
        thread_id: "t1",
      },
      created_at: `2025-01-01T00:00:${String(Math.abs(opts.step)).padStart(2, "0")}.000Z`,
      checkpoint: {
        thread_id: "t1",
        checkpoint_id: opts.checkpointId,
        checkpoint_ns: "",
        checkpoint_map: null,
      },
      parent_checkpoint: opts.parentCheckpointId
        ? {
            thread_id: "t1",
            checkpoint_id: opts.parentCheckpointId,
            checkpoint_ns: "",
            checkpoint_map: null,
          }
        : null,
    };
  }

  const getMessages = (values: Record<string, unknown>) =>
    (values?.messages ?? []) as Message[];

  function getMetadata(
    history: ThreadState<Record<string, unknown>>[],
    branch = ""
  ) {
    const branchCtx = getBranchContext(branch, history);
    const metadata = getMessagesMetadataMap({
      initialValues: { messages: [] },
      history,
      getMessages,
      branchContext: branchCtx,
    });

    return { branchCtx, metadata };
  }

  // Root checkpoint (empty state)
  const root = makeState({
    checkpointId: "root",
    parentCheckpointId: null,
    messages: [],
    step: -1,
    source: "input",
  });

  // --- Branch A: original "Hello" ---
  // Original submit creates 2 checkpoints (no INPUT_CP)
  const a0 = makeState({
    checkpointId: "a0",
    parentCheckpointId: "root",
    messages: [{ type: "human", content: "Hello", id: "hm-a" }],
    step: 0,
    source: "input",
  });
  const a1 = makeState({
    checkpointId: "a1",
    parentCheckpointId: "a0",
    messages: [
      { type: "human", content: "Hello", id: "hm-a" },
      { type: "ai", content: "Hey", id: "am-a" },
    ],
    step: 1,
    source: "loop",
  });

  // --- Branch B: fork "Hello" → "Hello v2" (from Root) ---
  // Fork creates 3 checkpoints: INPUT_CP + __start__ + agent
  const bInput = makeState({
    checkpointId: "b-input",
    parentCheckpointId: "root",
    messages: [], // INPUT_CP may have empty or partial state
    step: 0,
    source: "input",
  });
  const b0 = makeState({
    checkpointId: "b0",
    parentCheckpointId: "b-input",
    messages: [{ type: "human", content: "Hello v2", id: "hm-b" }],
    step: 1,
    source: "input",
  });
  const b1 = makeState({
    checkpointId: "b1",
    parentCheckpointId: "b0",
    messages: [
      { type: "human", content: "Hello v2", id: "hm-b" },
      { type: "ai", content: "Hey v2", id: "am-b" },
    ],
    step: 2,
    source: "loop",
  });

  // --- Branch C: fork "Hello v2" → "Hello v3" ---
  // BUG: without fix, this forks from b-input (nested), not root (flat)
  // With fix: forkParentCheckpoint should point to root
  const cInput = makeState({
    checkpointId: "c-input",
    parentCheckpointId: "root", // CORRECT: should fork from root
    messages: [],
    step: 0,
    source: "input",
  });
  const c0 = makeState({
    checkpointId: "c0",
    parentCheckpointId: "c-input",
    messages: [{ type: "human", content: "Hello v3", id: "hm-c" }],
    step: 1,
    source: "input",
  });
  const c1 = makeState({
    checkpointId: "c1",
    parentCheckpointId: "c0",
    messages: [
      { type: "human", content: "Hello v3", id: "hm-c" },
      { type: "ai", content: "Hey v3", id: "am-c" },
    ],
    step: 2,
    source: "loop",
  });

  it("forkParentCheckpoint skips INPUT_CP for forked messages", () => {
    // History after 2 forks (newest-first)
    const fullHistory = [c1, c0, cInput, b1, b0, bInput, a1, a0, root];

    const branchCtx = getBranchContext("", fullHistory);
    const metadata = getMessagesMetadataMap({
      initialValues: { messages: [] },
      history: fullHistory,
      getMessages,
      branchContext: branchCtx,
    });

    // Human message on the newest branch
    const humanMeta = metadata[0];
    expect(humanMeta).toBeDefined();

    // forkParentCheckpoint should be Root, not an INPUT_CP
    expect(humanMeta.forkParentCheckpoint?.checkpoint_id).toBe("root");

    // firstSeenState.parent_checkpoint might be an INPUT_CP (existing behavior)
    // forkParentCheckpoint should differ from it when intermediate CPs exist
    expect(humanMeta.forkParentCheckpoint).toBeDefined();
  });

  it("forkParentCheckpoint equals firstSeenState.parent_checkpoint for linear history", () => {
    // Linear history, no forks
    const linearHistory = [a1, a0, root];

    const { metadata } = getMetadata(linearHistory);

    const humanMeta = metadata[0];
    expect(humanMeta.forkParentCheckpoint?.checkpoint_id).toBe("root");
    expect(humanMeta.forkParentCheckpoint?.checkpoint_id).toBe(
      humanMeta.firstSeenState?.parent_checkpoint?.checkpoint_id
    );
  });

  it("strips nested same-message input checkpoints back to the original fork point", () => {
    // Old buggy topology after repeated edits of the same message:
    // Root → b-input → "Hello v2"
    //        └──────→ c-input → "Hello v3"
    // The stable fork point for "Hello v3" should still be Root.
    const cNestedInput = makeState({
      checkpointId: "c-nested-input",
      parentCheckpointId: "b-input",
      messages: [],
      step: 1,
      source: "input",
    });
    const cNested0 = makeState({
      checkpointId: "c-nested-0",
      parentCheckpointId: "c-nested-input",
      messages: [{ type: "human", content: "Hello v3", id: "hm-c-nested" }],
      step: 2,
      source: "input",
    });
    const cNested1 = makeState({
      checkpointId: "c-nested-1",
      parentCheckpointId: "c-nested-0",
      messages: [
        { type: "human", content: "Hello v3", id: "hm-c-nested" },
        { type: "ai", content: "Hey v3", id: "am-c-nested" },
      ],
      step: 3,
      source: "loop",
    });

    const fullHistory = [
      cNested1,
      cNested0,
      cNestedInput,
      b1,
      b0,
      bInput,
      a1,
      a0,
      root,
    ];

    const { metadata } = getMetadata(fullHistory);

    expect(metadata[0]?.firstSeenState?.parent_checkpoint?.checkpoint_id).toBe(
      "c-nested-input"
    );
    expect(metadata[0]?.branch).toBe("b-input>c-nested-input");
    expect(metadata[0]?.forkParentCheckpoint?.checkpoint_id).toBe("root");
  });

  it("uses the original turn input checkpoint for the first edit of a later-turn message on a branched conversation", () => {
    // Actual runtime topology on a branched thread:
    // Root → INPUT_A → "Hello v2" → "Hey"
    //                    ↓ submit("Follow up") with implicit threadHead checkpoint
    //                  turn2-input → "Follow up" → "Sure"
    //
    // The first edit of "Follow up" should branch from turn2-input, not Root.
    const inputA = makeState({
      checkpointId: "input-a-runtime",
      parentCheckpointId: "root",
      messages: [],
      step: 0,
      source: "input",
    });
    const h1v2 = makeState({
      checkpointId: "h1v2-runtime",
      parentCheckpointId: "input-a-runtime",
      messages: [{ type: "human", content: "Hello v2", id: "m-h1v2-runtime" }],
      step: 1,
      source: "input",
    });
    const ai1v2 = makeState({
      checkpointId: "ai1v2-runtime",
      parentCheckpointId: "h1v2-runtime",
      messages: [
        { type: "human", content: "Hello v2", id: "m-h1v2-runtime" },
        { type: "ai", content: "Hey", id: "m-ai1v2-runtime" },
      ],
      step: 2,
      source: "loop",
    });
    const turn2Input = makeState({
      checkpointId: "turn2-input-runtime",
      parentCheckpointId: "ai1v2-runtime",
      messages: [
        { type: "human", content: "Hello v2", id: "m-h1v2-runtime" },
        { type: "ai", content: "Hey", id: "m-ai1v2-runtime" },
      ],
      step: 3,
      source: "input",
    });
    const h2 = makeState({
      checkpointId: "h2-runtime",
      parentCheckpointId: "turn2-input-runtime",
      messages: [
        { type: "human", content: "Hello v2", id: "m-h1v2-runtime" },
        { type: "ai", content: "Hey", id: "m-ai1v2-runtime" },
        { type: "human", content: "Follow up", id: "m-h2-runtime" },
      ],
      step: 4,
      source: "input",
    });
    const ai2 = makeState({
      checkpointId: "ai2-runtime",
      parentCheckpointId: "h2-runtime",
      messages: [
        { type: "human", content: "Hello v2", id: "m-h1v2-runtime" },
        { type: "ai", content: "Hey", id: "m-ai1v2-runtime" },
        { type: "human", content: "Follow up", id: "m-h2-runtime" },
        { type: "ai", content: "Sure", id: "m-ai2-runtime" },
      ],
      step: 5,
      source: "loop",
    });

    const fullHistory = [
      ai2,
      h2,
      turn2Input,
      ai1v2,
      h1v2,
      inputA,
      a1,
      a0,
      root,
    ];

    const { metadata } = getMetadata(fullHistory);

    expect(metadata[2]?.firstSeenState?.parent_checkpoint?.checkpoint_id).toBe(
      "turn2-input-runtime"
    );
    expect(metadata[2]?.branch).toBeUndefined();
    expect(metadata[2]?.forkParentCheckpoint?.checkpoint_id).toBe(
      "turn2-input-runtime"
    );
  });

  it("keeps repeated later-turn edits anchored to the original turn input checkpoint", () => {
    // Runtime topology after editing a later-turn message once:
    // Root → INPUT_A → "Hello v2" → "Hey"
    //                    ↓ implicit submit
    //                  turn2-input → "Follow up" → "Sure"
    //                               └──────→ edit-input → "Follow up v2" → "Sure v2"
    //
    // Future edits of "Follow up v2" should still branch from turn2-input.
    const inputA = makeState({
      checkpointId: "input-a-runtime-repeat",
      parentCheckpointId: "root",
      messages: [],
      step: 0,
      source: "input",
    });
    const h1v2 = makeState({
      checkpointId: "h1v2-runtime-repeat",
      parentCheckpointId: "input-a-runtime-repeat",
      messages: [{ type: "human", content: "Hello v2", id: "m-h1v2-repeat" }],
      step: 1,
      source: "input",
    });
    const ai1v2 = makeState({
      checkpointId: "ai1v2-runtime-repeat",
      parentCheckpointId: "h1v2-runtime-repeat",
      messages: [
        { type: "human", content: "Hello v2", id: "m-h1v2-repeat" },
        { type: "ai", content: "Hey", id: "m-ai1v2-repeat" },
      ],
      step: 2,
      source: "loop",
    });
    const turn2Input = makeState({
      checkpointId: "turn2-input-runtime-repeat",
      parentCheckpointId: "ai1v2-runtime-repeat",
      messages: [
        { type: "human", content: "Hello v2", id: "m-h1v2-repeat" },
        { type: "ai", content: "Hey", id: "m-ai1v2-repeat" },
      ],
      step: 3,
      source: "input",
    });
    const h2 = makeState({
      checkpointId: "h2-runtime-repeat",
      parentCheckpointId: "turn2-input-runtime-repeat",
      messages: [
        { type: "human", content: "Hello v2", id: "m-h1v2-repeat" },
        { type: "ai", content: "Hey", id: "m-ai1v2-repeat" },
        { type: "human", content: "Follow up", id: "m-h2-repeat" },
      ],
      step: 4,
      source: "input",
    });
    const ai2 = makeState({
      checkpointId: "ai2-runtime-repeat",
      parentCheckpointId: "h2-runtime-repeat",
      messages: [
        { type: "human", content: "Hello v2", id: "m-h1v2-repeat" },
        { type: "ai", content: "Hey", id: "m-ai1v2-repeat" },
        { type: "human", content: "Follow up", id: "m-h2-repeat" },
        { type: "ai", content: "Sure", id: "m-ai2-repeat" },
      ],
      step: 5,
      source: "loop",
    });
    const editInput = makeState({
      checkpointId: "edit-input-runtime-repeat",
      parentCheckpointId: "turn2-input-runtime-repeat",
      messages: [
        { type: "human", content: "Hello v2", id: "m-h1v2-repeat" },
        { type: "ai", content: "Hey", id: "m-ai1v2-repeat" },
      ],
      step: 4,
      source: "input",
    });
    const h2v2 = makeState({
      checkpointId: "h2v2-runtime-repeat",
      parentCheckpointId: "edit-input-runtime-repeat",
      messages: [
        { type: "human", content: "Hello v2", id: "m-h1v2-repeat" },
        { type: "ai", content: "Hey", id: "m-ai1v2-repeat" },
        { type: "human", content: "Follow up v2", id: "m-h2v2-repeat" },
      ],
      step: 5,
      source: "input",
    });
    const ai2v2 = makeState({
      checkpointId: "ai2v2-runtime-repeat",
      parentCheckpointId: "h2v2-runtime-repeat",
      messages: [
        { type: "human", content: "Hello v2", id: "m-h1v2-repeat" },
        { type: "ai", content: "Hey", id: "m-ai1v2-repeat" },
        { type: "human", content: "Follow up v2", id: "m-h2v2-repeat" },
        { type: "ai", content: "Sure v2", id: "m-ai2v2-repeat" },
      ],
      step: 6,
      source: "loop",
    });

    const fullHistory = [
      ai2v2,
      h2v2,
      editInput,
      ai2,
      h2,
      turn2Input,
      ai1v2,
      h1v2,
      inputA,
      a1,
      a0,
      root,
    ];

    const { metadata } = getMetadata(fullHistory);

    expect(metadata[2]?.firstSeenState?.parent_checkpoint?.checkpoint_id).toBe(
      "edit-input-runtime-repeat"
    );
    expect(metadata[2]?.branch).toBe(
      "input-a-runtime-repeat>edit-input-runtime-repeat"
    );
    expect(metadata[2]?.forkParentCheckpoint?.checkpoint_id).toBe(
      "turn2-input-runtime-repeat"
    );
  });

  it("forkParentCheckpoint works for mid-conversation edits", () => {
    // Conversation: Root → H1("Hello") → AI1("Hey") → H2("Follow up") → AI2("Sure")
    const h1 = makeState({
      checkpointId: "h1",
      parentCheckpointId: "root",
      messages: [{ type: "human", content: "Hello", id: "msg-h1" }],
      step: 0,
      source: "input",
    });
    const ai1 = makeState({
      checkpointId: "ai1",
      parentCheckpointId: "h1",
      messages: [
        { type: "human", content: "Hello", id: "msg-h1" },
        { type: "ai", content: "Hey", id: "msg-ai1" },
      ],
      step: 1,
      source: "loop",
    });
    const h2 = makeState({
      checkpointId: "h2",
      parentCheckpointId: "ai1",
      messages: [
        { type: "human", content: "Hello", id: "msg-h1" },
        { type: "ai", content: "Hey", id: "msg-ai1" },
        { type: "human", content: "Follow up", id: "msg-h2" },
      ],
      step: 2,
      source: "input",
    });
    const ai2 = makeState({
      checkpointId: "ai2",
      parentCheckpointId: "h2",
      messages: [
        { type: "human", content: "Hello", id: "msg-h1" },
        { type: "ai", content: "Hey", id: "msg-ai1" },
        { type: "human", content: "Follow up", id: "msg-h2" },
        { type: "ai", content: "Sure", id: "msg-ai2" },
      ],
      step: 3,
      source: "loop",
    });

    // Fork "Follow up" → "Follow up v2" (from ai1 checkpoint)
    const fInput = makeState({
      checkpointId: "f-input",
      parentCheckpointId: "ai1", // fork from AI response checkpoint
      messages: [
        { type: "human", content: "Hello", id: "msg-h1" },
        { type: "ai", content: "Hey", id: "msg-ai1" },
      ],
      step: 2,
      source: "input",
    });
    const f0 = makeState({
      checkpointId: "f0",
      parentCheckpointId: "f-input",
      messages: [
        { type: "human", content: "Hello", id: "msg-h1" },
        { type: "ai", content: "Hey", id: "msg-ai1" },
        { type: "human", content: "Follow up v2", id: "msg-h2v2" },
      ],
      step: 3,
      source: "input",
    });
    const f1 = makeState({
      checkpointId: "f1",
      parentCheckpointId: "f0",
      messages: [
        { type: "human", content: "Hello", id: "msg-h1" },
        { type: "ai", content: "Hey", id: "msg-ai1" },
        { type: "human", content: "Follow up v2", id: "msg-h2v2" },
        { type: "ai", content: "Sure v2", id: "msg-ai2v2" },
      ],
      step: 4,
      source: "loop",
    });

    const fullHistory = [f1, f0, fInput, ai2, h2, ai1, h1, root];
    const branchCtx = getBranchContext("", fullHistory);
    const metadata = getMessagesMetadataMap({
      initialValues: { messages: [] },
      history: fullHistory,
      getMessages,
      branchContext: branchCtx,
    });

    // 3rd message is "Follow up v2" — its forkParentCheckpoint should be "ai1"
    const followUpMeta = metadata[2];
    expect(followUpMeta).toBeDefined();
    expect(followUpMeta.forkParentCheckpoint?.checkpoint_id).toBe("ai1");
  });

  it("forkParentCheckpoint uses nearest fork for nested multi-turn edits", () => {
    // Scenario: Fork turn 1, then fork turn 2 inside that branch.
    // Turn 1: Root → H1("Hello") → AI1("Hey")
    // Fork turn 1: Root → INPUT_A → H1'("Hello v2") → AI1'("Hey v2")
    // Fork turn 2 inside H1' branch:
    //   AI1' → INPUT_B → H2'("Follow up") → AI2'("Sure")
    //   AI1' → H2("Original follow up") → AI2("Original sure")
    //
    // H2's path should have 2 elements: [INPUT_A, INPUT_B]
    // forkParentCheckpoint for H2' should be AI1' (nearest fork), NOT Root

    const rr = makeState({
      checkpointId: "rr",
      parentCheckpointId: null,
      messages: [],
      step: -1,
      source: "input",
    });
    const h1 = makeState({
      checkpointId: "h1",
      parentCheckpointId: "rr",
      messages: [{ type: "human", content: "Hello", id: "m-h1" }],
      step: 0,
      source: "input",
    });
    const ai1 = makeState({
      checkpointId: "ai1",
      parentCheckpointId: "h1",
      messages: [
        { type: "human", content: "Hello", id: "m-h1" },
        { type: "ai", content: "Hey", id: "m-ai1" },
      ],
      step: 1,
      source: "loop",
    });
    // Fork turn 1: INPUT_A inserted by server
    const inputA = makeState({
      checkpointId: "input-a",
      parentCheckpointId: "rr",
      messages: [],
      step: 0,
      source: "input",
    });
    const h1v2 = makeState({
      checkpointId: "h1v2",
      parentCheckpointId: "input-a",
      messages: [{ type: "human", content: "Hello v2", id: "m-h1v2" }],
      step: 1,
      source: "input",
    });
    const ai1v2 = makeState({
      checkpointId: "ai1v2",
      parentCheckpointId: "h1v2",
      messages: [
        { type: "human", content: "Hello v2", id: "m-h1v2" },
        { type: "ai", content: "Hey v2", id: "m-ai1v2" },
      ],
      step: 2,
      source: "loop",
    });
    // Original turn 2 (on branch A)
    const h2orig = makeState({
      checkpointId: "h2orig",
      parentCheckpointId: "ai1v2",
      messages: [
        { type: "human", content: "Hello v2", id: "m-h1v2" },
        { type: "ai", content: "Hey v2", id: "m-ai1v2" },
        { type: "human", content: "Original follow up", id: "m-h2orig" },
      ],
      step: 3,
      source: "input",
    });
    const ai2orig = makeState({
      checkpointId: "ai2orig",
      parentCheckpointId: "h2orig",
      messages: [
        { type: "human", content: "Hello v2", id: "m-h1v2" },
        { type: "ai", content: "Hey v2", id: "m-ai1v2" },
        { type: "human", content: "Original follow up", id: "m-h2orig" },
        { type: "ai", content: "Original sure", id: "m-ai2orig" },
      ],
      step: 4,
      source: "loop",
    });
    // Fork turn 2 inside branch A: INPUT_B inserted by server
    const inputB = makeState({
      checkpointId: "input-b",
      parentCheckpointId: "ai1v2",
      messages: [
        { type: "human", content: "Hello v2", id: "m-h1v2" },
        { type: "ai", content: "Hey v2", id: "m-ai1v2" },
      ],
      step: 3,
      source: "input",
    });
    const h2v2 = makeState({
      checkpointId: "h2v2",
      parentCheckpointId: "input-b",
      messages: [
        { type: "human", content: "Hello v2", id: "m-h1v2" },
        { type: "ai", content: "Hey v2", id: "m-ai1v2" },
        { type: "human", content: "Follow up v2", id: "m-h2v2" },
      ],
      step: 4,
      source: "input",
    });
    const ai2v2 = makeState({
      checkpointId: "ai2v2",
      parentCheckpointId: "h2v2",
      messages: [
        { type: "human", content: "Hello v2", id: "m-h1v2" },
        { type: "ai", content: "Hey v2", id: "m-ai1v2" },
        { type: "human", content: "Follow up v2", id: "m-h2v2" },
        { type: "ai", content: "Sure v2", id: "m-ai2v2" },
      ],
      step: 5,
      source: "loop",
    });

    const fullHistory = [
      ai2v2, h2v2, inputB,
      ai2orig, h2orig,
      ai1v2, h1v2, inputA,
      ai1, h1, rr,
    ];

    // View the latest branch (branch A → fork of turn 2)
    const branchCtx = getBranchContext("", fullHistory);
    const metadata = getMessagesMetadataMap({
      initialValues: { messages: [] },
      history: fullHistory,
      getMessages,
      branchContext: branchCtx,
    });

    // First turn message: "Hello v2" — fork from Root
    const turn1Meta = metadata[0];
    expect(turn1Meta.forkParentCheckpoint?.checkpoint_id).toBe("rr");

    // Third message: "Follow up v2" — fork from AI1v2, NOT Root
    const turn2Meta = metadata[2];
    expect(turn2Meta).toBeDefined();
    expect(turn2Meta.forkParentCheckpoint?.checkpoint_id).toBe("ai1v2");
  });
});

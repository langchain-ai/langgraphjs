import { it, expect } from "vitest";
import { getBranchSequence } from "./branching.js";
import { ThreadState } from "../schema.js";

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

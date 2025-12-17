import type { ThreadState } from "../schema.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface Node<StateType = any> {
  type: "node";
  value: ThreadState<StateType>;
  path: string[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface Fork<StateType = any> {
  type: "fork";
  items: Array<Sequence<StateType>>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface Sequence<StateType = any> {
  type: "sequence";
  items: Array<Node<StateType> | Fork<StateType>>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface ValidFork<StateType = any> {
  type: "fork";
  items: Array<ValidSequence<StateType>>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface ValidSequence<StateType = any> {
  type: "sequence";
  items: [Node<StateType>, ...(Node<StateType> | ValidFork<StateType>)[]];
}

export function getBranchSequence<StateType extends Record<string, unknown>>(
  history: ThreadState<StateType>[]
) {
  const nodeIds = new Set<string>();
  const childrenMap: Record<string, ThreadState<StateType>[]> = {};

  // Short circuit if there's only a singular one state
  if (history.length <= 1) {
    return {
      rootSequence: {
        type: "sequence",
        items: history.map((value) => ({ type: "node", value, path: [] })),
      } satisfies Sequence<StateType>,
      paths: [],
    };
  }

  // First pass - collect nodes for each checkpoint
  history.forEach((state) => {
    const checkpointId = state.parent_checkpoint?.checkpoint_id ?? "$";
    childrenMap[checkpointId] ??= [];
    childrenMap[checkpointId].push(state);

    if (state.checkpoint?.checkpoint_id != null) {
      nodeIds.add(state.checkpoint.checkpoint_id);
    }
  });

  // If dealing with partial history, take the branch
  // with the latest checkpoint and mark it as the root.
  const maxId = (...ids: (string | null)[]) =>
    ids
      .filter((i): i is string => i != null)
      .sort((a, b) => a.localeCompare(b))
      .at(-1)!;

  const lastOrphanedNode =
    childrenMap.$ == null
      ? Object.keys(childrenMap)
          .filter((parentId) => !nodeIds.has(parentId))
          .map((parentId) => {
            const queue: string[] = [parentId];
            const seen = new Set<string>();

            let lastId = parentId;

            while (queue.length > 0) {
              const current = queue.shift()!;

              if (seen.has(current)) continue;
              seen.add(current);

              const children = (childrenMap[current] ?? []).flatMap(
                (i) => i.checkpoint?.checkpoint_id ?? []
              );

              lastId = maxId(lastId, ...children);
              queue.push(...children);
            }

            return { parentId, lastId };
          })
          .sort((a, b) => a.lastId.localeCompare(b.lastId))
          .at(-1)?.parentId
      : undefined;

  if (lastOrphanedNode != null) childrenMap.$ = childrenMap[lastOrphanedNode];

  // Second pass - create a tree of sequences
  type Task = { id: string; sequence: Sequence; path: string[] };
  const rootSequence: Sequence = { type: "sequence", items: [] };
  const queue: Task[] = [{ id: "$", sequence: rootSequence, path: [] }];

  const paths: string[][] = [];

  const visited = new Set<string>();
  while (queue.length > 0) {
    const task = queue.shift()!;
    if (visited.has(task.id)) continue;
    visited.add(task.id);

    const children = childrenMap[task.id];
    if (children == null || children.length === 0) continue;

    // If we've encountered a fork (2+ children), push the fork
    // to the sequence and add a new sequence for each child
    let fork: Fork | undefined;
    if (children.length > 1) {
      fork = { type: "fork", items: [] };
      task.sequence.items.push(fork);
    }

    for (const value of children) {
      const id = value.checkpoint?.checkpoint_id;
      if (id == null) continue;

      let { sequence } = task;
      let { path } = task;
      if (fork != null) {
        sequence = { type: "sequence", items: [] };
        fork.items.unshift(sequence);

        path = path.slice();
        path.push(id);
        paths.push(path);
      }

      sequence.items.push({ type: "node", value, path });
      queue.push({ id, sequence, path });
    }
  }

  return { rootSequence, paths };
}

const PATH_SEP = ">";
const ROOT_ID = "$";

// Get flat view
export function getBranchView<StateType extends Record<string, unknown>>(
  sequence: Sequence<StateType>,
  paths: string[][],
  branch: string
) {
  const path = branch.split(PATH_SEP);
  const pathMap: Record<string, string[][]> = {};

  for (const path of paths) {
    const parent = path.at(-2) ?? ROOT_ID;
    pathMap[parent] ??= [];
    pathMap[parent].unshift(path);
  }

  const history: ThreadState<StateType>[] = [];
  const branchByCheckpoint: Record<
    string,
    { branch: string | undefined; branchOptions: string[] | undefined }
  > = {};

  const forkStack = path.slice();
  const queue: (Node<StateType> | Fork<StateType>)[] = [...sequence.items];

  while (queue.length > 0) {
    const item = queue.shift()!;

    if (item.type === "node") {
      history.push(item.value);
      const checkpointId = item.value.checkpoint?.checkpoint_id;
      if (checkpointId == null) continue;

      branchByCheckpoint[checkpointId] = {
        branch: item.path.join(PATH_SEP),
        branchOptions: (item.path.length > 0
          ? pathMap[item.path.at(-2) ?? ROOT_ID] ?? []
          : []
        ).map((p) => p.join(PATH_SEP)),
      };
    }
    if (item.type === "fork") {
      const forkId = forkStack.shift();
      const index =
        forkId != null
          ? item.items.findIndex((value) => {
              const firstItem = value.items.at(0);
              if (!firstItem || firstItem.type !== "node") return false;
              return firstItem.value.checkpoint?.checkpoint_id === forkId;
            })
          : -1;

      const nextItems = item.items.at(index)?.items ?? [];
      queue.push(...nextItems);
    }
  }

  return { history, branchByCheckpoint };
}

export function getBranchContext<StateType extends Record<string, unknown>>(
  branch: string,
  history: ThreadState<StateType>[] | undefined
) {
  const { rootSequence: branchTree, paths } = getBranchSequence(history ?? []);
  const { history: flatHistory, branchByCheckpoint } = getBranchView(
    branchTree,
    paths,
    branch
  );

  return {
    branchTree,
    flatHistory,
    branchByCheckpoint,
    threadHead: flatHistory.at(-1),
  };
}

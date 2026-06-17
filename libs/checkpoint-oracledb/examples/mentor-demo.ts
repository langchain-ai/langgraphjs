import { config as loadEnv } from "dotenv";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";

import { OracleCheckpointSaver, OracleStore } from "../src/index.js";

loadEnv();

const DEFAULT_TABLE_PREFIX = "LG_MENTOR_DEMO_";
const DEFAULT_THREAD_ID = "mentor-demo-thread";
const DEFAULT_MESSAGE = "Oracle Database persists LangGraph state";

type CliOptions = {
  reset: boolean;
  threadId: string;
  tablePrefix: string;
  message: string;
};

type DemoMemoryValue = {
  kind?: string;
  topic?: string;
  score?: number;
  value?: string;
  updated?: boolean;
};

const DemoState = Annotation.Root({
  input: Annotation<string>({
    reducer: (_, next) => next,
    default: () => "",
  }),
  normalized: Annotation<string>({
    reducer: (_, next) => next,
    default: () => "",
  }),
  count: Annotation<number>({
    reducer: (current, next) => current + next,
    default: () => 0,
  }),
  history: Annotation<string[]>({
    reducer: (current, next) => current.concat(next),
    default: () => [],
  }),
  response: Annotation<string>({
    reducer: (_, next) => next,
    default: () => "",
  }),
});

function readOption(name: string): string | undefined {
  const equalsPrefix = `--${name}=`;
  for (let i = 2; i < process.argv.length; i += 1) {
    const arg = process.argv[i];
    if (arg.startsWith(equalsPrefix)) return arg.slice(equalsPrefix.length);
    if (arg === `--${name}`) {
      const value = process.argv[i + 1];
      if (value && !value.startsWith("--")) return value;
    }
  }
  return undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function isOptionValue(args: string[], index: number): boolean {
  const previous = args[index - 1];
  return (
    previous === "--thread" ||
    previous === "--prefix" ||
    previous === "--table-prefix" ||
    previous === "--message"
  );
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing ${name}. Set it in .env or export it before running.`
    );
  }
  return value;
}

function getCliOptions(): CliOptions {
  const args = process.argv.slice(2);
  const positionalMessage = args
    .filter(
      (arg, index) =>
        arg !== "--" && !arg.startsWith("--") && !isOptionValue(args, index)
    )
    .join(" ");

  return {
    reset: hasFlag("reset"),
    threadId: readOption("thread") ?? DEFAULT_THREAD_ID,
    tablePrefix:
      readOption("prefix") ??
      readOption("table-prefix") ??
      process.env.ORACLE_LANGGRAPH_TABLE_PREFIX ??
      DEFAULT_TABLE_PREFIX,
    message: readOption("message") ?? (positionalMessage || DEFAULT_MESSAGE),
  };
}

function section(title: string): void {
  console.log(`\n${title}`);
  console.log("-".repeat(title.length));
}

function compact(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function summarizeItems(
  items: Array<{ key: string; value: Record<string, unknown> }>
): Array<{ key: string } & DemoMemoryValue> {
  return items.map((item) => ({
    key: item.key,
    ...(item.value as DemoMemoryValue),
  }));
}

async function clearStoreNamespace(
  store: OracleStore,
  namespacePrefix: string[]
): Promise<number> {
  const existing = await store.search(namespacePrefix, { limit: 500 });
  await Promise.all(
    existing.map((item) => store.delete(item.namespace, item.key))
  );
  return existing.length;
}

async function runCheckpointDemo({
  checkpointer,
  threadId,
  message,
  reset,
}: {
  checkpointer: OracleCheckpointSaver;
  threadId: string;
  message: string;
  reset: boolean;
}): Promise<void> {
  const config = {
    configurable: {
      thread_id: threadId,
    },
  };

  if (reset) {
    await checkpointer.deleteThread(threadId);
    console.log(`Reset checkpoint thread: ${threadId}`);
  }

  const workflow = new StateGraph(DemoState)
    .addNode("normalize", async (state) => ({
      normalized: state.input.trim().replace(/\s+/g, " "),
    }))
    .addNode("record", async (state) => {
      const turn = state.count + 1;
      const response = `Turn ${turn}: recorded "${state.normalized}".`;
      return {
        count: 1,
        history: [`${turn}. ${state.normalized}`],
        response,
      };
    })
    .addEdge(START, "normalize")
    .addEdge("normalize", "record")
    .addEdge("record", END);

  const graph = workflow.compile({ checkpointer });
  const previousTuple = await checkpointer.getTuple(config);
  const firstResult = await graph.invoke(
    { input: `${message} [first invoke]` },
    config
  );
  const firstCheckpoint = await checkpointer.getTuple(config);
  const secondResult = await graph.invoke(
    { input: `${message} [second invoke]` },
    config
  );
  const latestTuple = await checkpointer.getTuple(config);
  const latestState = await graph.getState(config);
  const checkpoints = [];
  for await (const tuple of checkpointer.list(config, { limit: 50 })) {
    checkpoints.push(tuple);
  }

  section("OracleCheckpointSaver");
  console.log(`thread_id: ${threadId}`);
  console.log(
    `previous checkpoint before demo: ${previousTuple ? "yes" : "no"}`
  );
  console.log(`first invoke checkpoint_id: ${firstCheckpoint?.checkpoint.id}`);
  console.log(`latest checkpoint_id: ${latestTuple?.checkpoint.id}`);
  console.log(`checkpoints listed: ${checkpoints.length}`);
  console.log(`first invoke count: ${firstResult.count}`);
  console.log(`second invoke count: ${secondResult.count}`);
  console.log("current persisted state:");
  console.log(compact(latestState.values));
}

async function runStoreDemo({
  store,
  threadId,
  reset,
}: {
  store: OracleStore;
  threadId: string;
  reset: boolean;
}): Promise<void> {
  const namespace = ["mentor-demo", threadId, "memories"];

  if (reset) {
    const removed = await clearStoreNamespace(store, ["mentor-demo", threadId]);
    console.log(`Reset store rows under mentor-demo/${threadId}: ${removed}`);
  }

  await store.put(namespace, "profile", {
    kind: "profile",
    topic: "database",
    score: 5,
    value: "Initial profile memory",
  });
  await store.put(namespace, "preference", {
    kind: "preference",
    topic: "agent-memory",
    score: 8,
    value: "Prefers deterministic demos",
  });
  await store.put(namespace, "", {
    kind: "empty-key",
    topic: "edge-case",
    score: 7,
    value: "Empty key round trip",
  });
  await store.put(namespace, "scratch", {
    kind: "temporary",
    topic: "cleanup",
    score: 1,
    value: "This row will be deleted",
  });

  await store.put(namespace, "profile", {
    kind: "profile",
    topic: "database",
    score: 9,
    value: "Updated profile memory",
    updated: true,
  });

  const profile = await store.get(namespace, "profile");
  const emptyKey = await store.get(namespace, "");
  const exactFilter = await store.search(["mentor-demo", threadId], {
    filter: { kind: "profile" },
  });
  const eqFilter = await store.search(["mentor-demo", threadId], {
    filter: { topic: { $eq: "database" } },
  });
  const inFilter = await store.search(["mentor-demo", threadId], {
    filter: { kind: { $in: ["profile", "preference"] } },
  });
  const rangeFilter = await store.search(["mentor-demo", threadId], {
    filter: { score: { $gte: 7 } },
  });
  const namespaces = await store.listNamespaces({
    prefix: ["mentor-demo", threadId],
    maxDepth: 3,
  });

  await store.delete(namespace, "scratch");
  const deletedScratch = await store.get(namespace, "scratch");

  section("OracleStore");
  console.log("profile after repeated put:");
  console.log(compact(profile));
  console.log("empty key round trip:");
  console.log(compact(emptyKey));
  console.log("search exact filter { kind: 'profile' }:");
  console.log(compact(summarizeItems(exactFilter)));
  console.log("search $eq filter { topic: { $eq: 'database' } }:");
  console.log(compact(summarizeItems(eqFilter)));
  console.log(
    "search $in filter { kind: { $in: ['profile', 'preference'] } }:"
  );
  console.log(compact(summarizeItems(inFilter)));
  console.log("search range filter { score: { $gte: 7 } }:");
  console.log(compact(summarizeItems(rangeFilter)));
  console.log("listNamespaces prefix + maxDepth:");
  console.log(compact(namespaces));
  console.log(
    `delete scratch row result: ${
      deletedScratch === null ? "deleted" : "still present"
    }`
  );
}

async function main(): Promise<void> {
  const options = getCliOptions();
  const connection = {
    user: requiredEnv("ORACLE_USER"),
    password: requiredEnv("ORACLE_PASSWORD"),
    connectString: requiredEnv("ORACLE_CONNECT_STRING"),
  };

  const checkpointer = new OracleCheckpointSaver({
    connection,
    tablePrefix: options.tablePrefix,
  });
  const store = new OracleStore({
    connection,
    tablePrefix: options.tablePrefix,
  });

  try {
    await checkpointer.setup();
    await store.start();

    section("Mentor Demo Configuration");
    console.log(`thread_id: ${options.threadId}`);
    console.log(`tablePrefix: ${options.tablePrefix}`);
    console.log(`reset: ${options.reset ? "yes" : "no"}`);

    await runCheckpointDemo({
      checkpointer,
      threadId: options.threadId,
      message: options.message,
      reset: options.reset,
    });
    await runStoreDemo({
      store,
      threadId: options.threadId,
      reset: options.reset,
    });

    section("Demo Result");
    console.log(
      "OracleCheckpointSaver persisted and resumed a real StateGraph."
    );
    console.log(
      "OracleStore persisted JSON memories, filters, namespaces, empty keys, and deletes."
    );
  } finally {
    await store.stop();
    await checkpointer.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

import { config as loadEnv } from "dotenv";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";

import { OracleCheckpointSaver, OracleStore } from "../src/index.js";

loadEnv();

type DemoRoute = "short_reply" | "long_reply";
type DemoMemory = {
  input?: string;
  response?: string;
  turn?: number;
  wordCount?: number;
  totalWords?: number;
  createdAt?: string;
};

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv
    .find((arg) => arg.startsWith(prefix))
    ?.slice(prefix.length);
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
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

const DemoState = Annotation.Root({
  input: Annotation<string>({
    reducer: (_, next) => next,
    default: () => "",
  }),
  normalized: Annotation<string>({
    reducer: (_, next) => next,
    default: () => "",
  }),
  wordCount: Annotation<number>({
    reducer: (_, next) => next,
    default: () => 0,
  }),
  totalWords: Annotation<number>({
    reducer: (current, next) => current + next,
    default: () => 0,
  }),
  response: Annotation<string>({
    reducer: (_, next) => next,
    default: () => "",
  }),
  operations: Annotation<string[]>({
    reducer: (current, next) => current.concat(next),
    default: () => [],
  }),
  history: Annotation<string[]>({
    reducer: (current, next) => current.concat(next),
    default: () => [],
  }),
});

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function memorySortValue(memory: {
  key: string;
  value: Record<string, unknown>;
}): number {
  const value = memory.value as DemoMemory;
  if (typeof value.turn === "number") return value.turn;
  if (typeof value.createdAt === "string") {
    const timestamp = Date.parse(value.createdAt);
    if (Number.isFinite(timestamp)) return timestamp;
  }
  const keyMatch = memory.key.match(/^turn-(\d+)$/);
  return keyMatch ? Number(keyMatch[1]) : 0;
}

async function main(): Promise<void> {
  const threadId = readArg("thread") ?? "oracle-graph-demo-thread";
  const tablePrefix = readArg("table-prefix") ?? "LG_GRAPH_DEMO_";
  const message =
    readArg("message") ??
    (process.argv
      .slice(2)
      .filter((arg) => !arg.startsWith("--"))
      .join(" ") ||
      "Oracle Database checkpoints should persist this graph state");

  const connection = {
    user: requiredEnv("ORACLE_USER"),
    password: requiredEnv("ORACLE_PASSWORD"),
    connectString: requiredEnv("ORACLE_CONNECT_STRING"),
  };

  const checkpointer = new OracleCheckpointSaver({
    connection,
    tablePrefix,
  });
  const store = new OracleStore({
    connection,
    tablePrefix,
  });

  const config = {
    configurable: {
      thread_id: threadId,
    },
  };

  const workflow = new StateGraph(DemoState)
    .addNode("normalize", async (state) => {
      const normalized = state.input.trim().replace(/\s+/g, " ");
      return {
        normalized,
        history: [`user: ${normalized}`],
        operations: [`normalize("${normalized}")`],
      };
    })
    .addNode("count_words", async (state) => {
      const words = countWords(state.normalized);
      return {
        wordCount: words,
        totalWords: words,
        operations: [`count_words(${words})`],
      };
    })
    .addNode("short_reply", async (state) => ({
      response: `Short input received: ${state.wordCount} word(s). Total words for this thread: ${state.totalWords}.`,
      operations: ["short_reply"],
    }))
    .addNode("long_reply", async (state) => ({
      response: `Longer input received: ${state.wordCount} word(s). Total words for this thread: ${state.totalWords}.`,
      operations: ["long_reply"],
    }))
    .addNode("remember", async (state) => {
      const turn = Math.floor((state.history.length + 1) / 2);
      const key = `turn-${String(turn).padStart(4, "0")}`;
      await store.put(["oracle-graph-demo", threadId], key, {
        input: state.normalized,
        response: state.response,
        turn,
        wordCount: state.wordCount,
        totalWords: state.totalWords,
        createdAt: new Date().toISOString(),
      });

      return {
        history: [`agent: ${state.response}`],
        operations: [`store.put(${key})`],
      };
    })
    .addEdge(START, "normalize")
    .addEdge("normalize", "count_words")
    .addConditionalEdges(
      "count_words",
      (state): DemoRoute =>
        state.wordCount > 6 ? "long_reply" : "short_reply",
      {
        short_reply: "short_reply",
        long_reply: "long_reply",
      }
    )
    .addEdge("short_reply", "remember")
    .addEdge("long_reply", "remember")
    .addEdge("remember", END);

  try {
    await checkpointer.setup();
    await store.start();

    if (hasFlag("reset")) {
      await checkpointer.deleteThread(threadId);
      const existing = await store.search(["oracle-graph-demo", threadId], {
        limit: 100,
      });
      await Promise.all(
        existing.map((item) => store.delete(item.namespace, item.key))
      );
      console.log(`Reset Oracle demo data for thread "${threadId}".`);
    }

    const graph = workflow.compile({ checkpointer });
    const previousTuple = await checkpointer.getTuple(config);
    const result = await graph.invoke({ input: message }, config);
    const latestState = await graph.getState(config);
    const memories = await store.search(["oracle-graph-demo", threadId], {
      limit: 20,
    });
    const latestTwoMemories = [...memories]
      .sort((left, right) => memorySortValue(left) - memorySortValue(right))
      .slice(-2);
    const checkpoints = [];
    for await (const checkpoint of checkpointer.list(config, { limit: 20 })) {
      checkpoints.push(checkpoint);
    }

    console.log("\nOracle LangGraph StateGraph demo");
    console.log("--------------------------------");
    console.log(`thread_id: ${threadId}`);
    console.log(`tablePrefix: ${tablePrefix}`);
    console.log(
      `had checkpoint before invoke: ${previousTuple ? "yes" : "no"}`
    );
    console.log(`checkpoints listed: ${checkpoints.length}`);
    console.log(`store memory rows: ${memories.length}`);
    console.log("\nGraph result:");
    console.log(JSON.stringify(result, null, 2));
    console.log("\nLatest checkpointed state:");
    console.log(JSON.stringify(latestState.values, null, 2));
    console.log("\nLatest two OracleStore memory rows:");
    console.log(JSON.stringify(latestTwoMemories, null, 2));
    console.log(
      "\nRun the command again with the same --thread value to verify resume."
    );
    console.log("Use --reset to clear this demo thread before invoking.\n");
  } finally {
    await store.stop();
    await checkpointer.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

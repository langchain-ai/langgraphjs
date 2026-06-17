import { config as loadEnv } from "dotenv";
import type { IndexConfig } from "@langchain/langgraph-checkpoint";

import { OracleStore } from "../src/index.js";

loadEnv();

const DEFAULT_TABLE_PREFIX = "LG_MENTOR_VECTOR_DEMO_";
const DEFAULT_THREAD_ID = "mentor-vector-demo-thread";

type CliOptions = {
  reset: boolean;
  threadId: string;
  tablePrefix: string;
};

type VectorValue = {
  text?: string;
  kind?: string;
  metadata?: {
    summary?: string;
  };
};

const deterministicEmbeddings = {
  async embedDocuments(texts: string[]): Promise<number[][]> {
    return texts.map(embedText);
  },
  async embedQuery(text: string): Promise<number[]> {
    return embedText(text);
  },
};

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
  return {
    reset: hasFlag("reset"),
    threadId: readOption("thread") ?? DEFAULT_THREAD_ID,
    tablePrefix:
      readOption("prefix") ??
      readOption("table-prefix") ??
      process.env.ORACLE_LANGGRAPH_TABLE_PREFIX ??
      DEFAULT_TABLE_PREFIX,
  };
}

function embedText(text: string): number[] {
  const normalized = text.toLowerCase();
  const vector: number[] = [0, 0, 0, 0];
  if (/(oracle|database|vector|checkpoint|memory)/.test(normalized)) {
    vector[0] += 1;
  }
  if (/(fruit|apple|banana)/.test(normalized)) {
    vector[1] += 1;
  }
  if (/(travel|paris|flight)/.test(normalized)) {
    vector[2] += 1;
  }
  if (/(recipe|cooking|coffee)/.test(normalized)) {
    vector[3] += 1;
  }
  if (!vector.some((value) => value !== 0)) vector[3] = 1;

  const norm = Math.hypot(...vector);
  return vector.map((value) => value / norm);
}

function getErrorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(error ?? "unknown error");
}

function isVectorUnsupportedError(error: unknown): boolean {
  const message = getErrorMessage(error);
  return /VECTOR|TO_VECTOR|VECTOR_DISTANCE|ORA-00902|ORA-00904|ORA-03001/i.test(
    message
  );
}

function section(title: string): void {
  console.log(`\n${title}`);
  console.log("-".repeat(title.length));
}

function compact(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function summarizeVectorResults(
  items: Array<{
    key: string;
    score?: number;
    value: Record<string, unknown>;
  }>
): Array<{
  key: string;
  score: number | null;
  kind?: string;
  text?: string;
  summary?: string;
}> {
  return items.map((item) => {
    const value = item.value as VectorValue;
    return {
      key: item.key,
      score: item.score ?? null,
      kind: value.kind,
      text: value.text,
      summary: value.metadata?.summary,
    };
  });
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

async function main(): Promise<void> {
  const options = getCliOptions();
  const connection = {
    user: requiredEnv("ORACLE_USER"),
    password: requiredEnv("ORACLE_PASSWORD"),
    connectString: requiredEnv("ORACLE_CONNECT_STRING"),
  };
  const namespace = ["mentor-vector-demo", options.threadId, "memories"];
  const indexConfig: IndexConfig = {
    dims: 4,
    embeddings: deterministicEmbeddings as unknown as IndexConfig["embeddings"],
    fields: ["text", "metadata.summary", "chapters[*].content"],
  };
  const store = new OracleStore({
    connection,
    tablePrefix: options.tablePrefix,
    index: indexConfig,
  });

  try {
    await store.start();

    section("Mentor VECTOR Demo Configuration");
    console.log(`thread_id: ${options.threadId}`);
    console.log(`tablePrefix: ${options.tablePrefix}`);
    console.log(`reset: ${options.reset ? "yes" : "no"}`);

    if (options.reset) {
      const removed = await clearStoreNamespace(store, [
        "mentor-vector-demo",
        options.threadId,
      ]);
      console.log(`Reset vector store rows: ${removed}`);
    }

    await store.put(namespace, "oracle-vector", {
      kind: "database",
      text: "Oracle Database vector search for LangGraph memory",
      metadata: { summary: "database vector memory" },
      chapters: [
        { content: "Oracle 23ai VECTOR can rank semantic memory rows." },
      ],
    });
    await store.put(namespace, "chapter-only", {
      kind: "database",
      text: "Architecture notes",
      metadata: { summary: "checkpoint persistence" },
      chapters: [
        { content: "LangGraph checkpoints and Oracle VECTOR retrieval." },
      ],
    });
    await store.put(namespace, "fruit-note", {
      kind: "personal",
      text: "Apple and banana preferences",
      metadata: { summary: "fruit preference memory" },
      chapters: [{ content: "Fruit notes are unrelated to database search." }],
    });
    await store.put(
      namespace,
      "unindexed-database",
      {
        kind: "database",
        text: "Oracle Database row stored without vector indexing",
        metadata: { summary: "scoreless database memory" },
        chapters: [{ content: "This row should appear without a score." }],
      },
      false
    );

    const vectorResults = await store.search(namespace, {
      query: "oracle database vector memory",
      limit: 6,
    });
    const filteredVectorResults = await store.search(namespace, {
      query: "oracle database vector memory",
      filter: { kind: "database" },
      limit: 6,
    });

    section("OracleStore VECTOR Search");
    console.log("query: oracle database vector memory");
    console.log("scored rows should appear before scoreless unindexed rows:");
    console.log(compact(summarizeVectorResults(vectorResults)));
    console.log("filtered vector search { kind: 'database' }:");
    console.log(compact(summarizeVectorResults(filteredVectorResults)));

    section("Demo Result");
    console.log("OracleStore created vector rows from configured fields.");
    console.log(
      "Oracle VECTOR search returned scored and scoreless memory rows."
    );
  } catch (error) {
    if (isVectorUnsupportedError(error)) {
      console.log("\nOracle VECTOR demo skipped.");
      console.log(
        "The connected Oracle database does not appear to support VECTOR operations required by this demo."
      );
      console.log(getErrorMessage(error));
      return;
    }
    throw error;
  } finally {
    await store.stop();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

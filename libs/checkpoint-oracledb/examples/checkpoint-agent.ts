import { config as loadEnv } from "dotenv";
import {
  type Checkpoint,
  type CheckpointMetadata,
  uuid6,
} from "@langchain/langgraph-checkpoint";

import { OracleCheckpointSaver } from "../src/saver.js";

loadEnv();

type AgentState = {
  turn: number;
  messages: string[];
};

const CHANNEL = "agent_state";

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

function initialState(): AgentState {
  return {
    turn: 0,
    messages: [],
  };
}

function getState(checkpoint: Checkpoint | undefined): AgentState {
  return (
    (checkpoint?.channel_values[CHANNEL] as AgentState | undefined) ??
    initialState()
  );
}

function nextVersion(checkpoint: Checkpoint | undefined): number {
  const current = checkpoint?.channel_versions[CHANNEL];
  return typeof current === "number" ? current + 1 : 1;
}

function respond(input: string, state: AgentState): string {
  const previousUserMessages = state.messages.filter((message) =>
    message.startsWith("User:")
  );
  const memory =
    previousUserMessages.length === 0
      ? "I do not have previous messages for this thread yet."
      : `I remember ${previousUserMessages.length} previous user message(s): ${previousUserMessages
          .map((message) => message.replace(/^User:\s*/, ""))
          .join(" | ")}`;

  return `Turn ${state.turn + 1}: You said "${input}". ${memory}`;
}

async function main(): Promise<void> {
  const threadId = readArg("thread") ?? "oracle-demo-thread";
  const checkpointNs = readArg("namespace") ?? "";
  const tablePrefix = readArg("table-prefix") ?? "LG_AGENT_DEMO_";
  const message =
    readArg("message") ??
    (process.argv
      .slice(2)
      .filter((arg) => arg !== "--" && !arg.startsWith("--"))
      .join(" ") ||
      "hello from the Oracle checkpoint demo");

  const checkpointer = new OracleCheckpointSaver({
    connection: {
      user: requiredEnv("ORACLE_USER"),
      password: requiredEnv("ORACLE_PASSWORD"),
      connectString: requiredEnv("ORACLE_CONNECT_STRING"),
    },
    tablePrefix,
  });

  await checkpointer.setup();

  if (hasFlag("reset")) {
    await checkpointer.deleteThread(threadId);
    console.log(`Deleted checkpoints for thread "${threadId}".`);
  }

  const baseConfig = {
    configurable: {
      thread_id: threadId,
      checkpoint_ns: checkpointNs,
    },
  };

  const previousTuple = await checkpointer.getTuple(baseConfig);
  const previousCheckpoint = previousTuple?.checkpoint;
  const previousState = getState(previousCheckpoint);
  const response = respond(message, previousState);
  const updatedState: AgentState = {
    turn: previousState.turn + 1,
    messages: previousState.messages.concat([
      `User: ${message}`,
      `Agent: ${response}`,
    ]),
  };
  const version = nextVersion(previousCheckpoint);

  const checkpoint: Checkpoint = {
    v: 4,
    id: uuid6(0),
    ts: new Date().toISOString(),
    channel_values: {
      [CHANNEL]: updatedState,
    },
    channel_versions: {
      ...(previousCheckpoint?.channel_versions ?? {}),
      [CHANNEL]: version,
    },
    versions_seen: previousCheckpoint?.versions_seen ?? {},
  };

  const metadata: CheckpointMetadata = {
    source: "loop",
    step: updatedState.turn,
    parents: {},
  };

  const savedConfig = await checkpointer.put(
    {
      configurable: {
        ...baseConfig.configurable,
        checkpoint_id: previousCheckpoint?.id,
      },
    },
    checkpoint,
    metadata,
    { [CHANNEL]: version }
  );

  await checkpointer.putWrites(
    savedConfig,
    [["agent_events", { turn: updatedState.turn, message, response }]],
    "demo-agent"
  );

  const latestTuple = await checkpointer.getTuple(baseConfig);
  const checkpoints = [];
  for await (const tuple of checkpointer.list(baseConfig, { limit: 20 })) {
    checkpoints.push(tuple);
  }

  console.log("\nOracle checkpointed agent demo");
  console.log("--------------------------------");
  console.log(`thread_id: ${threadId}`);
  console.log(`checkpoint_ns: ${checkpointNs || "<root>"}`);
  console.log(`tablePrefix: ${tablePrefix}`);
  console.log(`had checkpoint before invoke: ${previousTuple ? "yes" : "no"}`);
  console.log(
    `saved checkpoint id: ${savedConfig.configurable?.checkpoint_id}`
  );
  console.log(
    `latest checkpoint id: ${latestTuple?.checkpoint.id ?? "<none>"}`
  );
  console.log(`stored checkpoints listed: ${checkpoints.length}`);
  console.log("\nLatest agent state:");
  console.log(
    JSON.stringify(latestTuple?.checkpoint.channel_values[CHANNEL], null, 2)
  );
  console.log("\nPending writes on latest checkpoint:");
  console.log(JSON.stringify(latestTuple?.pendingWrites ?? [], null, 2));
  console.log(
    "\nRun the same command again with the same --thread value to verify resume."
  );
  console.log(
    "Use --reset to delete that thread's checkpoints before invoking.\n"
  );

  await checkpointer.end();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

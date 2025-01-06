import { Config, StreamMode } from "./storage/ops.mjs";
import { getGraph } from "./graph/load.mjs";
import { CompiledGraph } from "@langchain/langgraph";

type Event<Type, Value> = { type: Type; value: Value };

type ApiStreamEvent =
  | Event<"metadata", { run_id: string }>
  | Event<
      "events",
      // TODO: extract the type from @langchain/core
      {
        event: string;
        name: string;
        run_id: string;
        tags?: string[];
        metadata: Record<string, any>;
        data: { input?: any; output?: any; chunk?: any };
      }
    >;

interface Run {
  runId: string;
  kwargs: {
    input: unknown;
    streamMode?: Array<StreamMode>;

    // TODO: implement webhook
    webhook?: unknown;
    // TODO: implement feedback_keys
    feedbackKeys?: string | string[] | undefined;

    interruptBefore?: string | string[] | undefined;
    interruptAfter?: string | string[] | undefined;
    temporary: boolean;

    config: Config;

    [key: string]: unknown;
  };
}
export async function* streamState(
  run: Run,
  options?: {
    onGraph?: (graph: CompiledGraph<string>) => void;
  }
): AsyncGenerator<ApiStreamEvent> {
  const graphId = run.kwargs.config.configurable?.graph_id;
  if (!graphId || typeof graphId !== "string") {
    throw new Error("Invalid or missing graph_id");
  }

  const runId = run.runId;
  const graph = getGraph(graphId);
  const streamMode: StreamMode[] = run.kwargs.streamMode ?? ["updates"];

  options?.onGraph?.(graph);

  yield { type: "metadata", value: { run_id: run.runId } };

  // TODO: implement other stream modes
  const events = graph.streamEvents(run.kwargs.input, {
    version: "v2",

    tags: run.kwargs.config.tags,
    configurable: run.kwargs.config.configurable,
    recursionLimit: run.kwargs.config.recursion_limit,

    runId,
    // @ts-expect-error TODO: allow multiple stream modes
    streamMode: streamMode[0],
  });

  for await (const event of events) {
    if (streamMode.includes("events")) yield { type: "events", value: event };
    if (streamMode.includes("messages")) {
    }
  }
}

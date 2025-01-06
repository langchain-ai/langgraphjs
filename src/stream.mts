import { Run, RunCommand, RunSend } from "./storage/ops.mjs";
import { getGraph } from "./graph/load.mjs";
import { Command, Send } from "@langchain/langgraph";

// TODO: these types are not exported from @langchain/langgraph/pregel
type LangGraphStreamMode =
  | "values"
  | "messages"
  | "updates"
  | "debug"
  | "custom";

const getLangGraphCommand = (command: RunCommand) => {
  let goto =
    command.goto != null && !Array.isArray(command.goto)
      ? [command.goto]
      : command.goto;

  return new Command({
    goto: goto?.map((item: string | RunSend) => {
      if (typeof item !== "string") return new Send(item.node, item.input);
      return item;
    }),
    update: command.update,
    resume: command.resume,
  });
};

export async function* streamState(
  run: Run,
  attempt: number = 1
): AsyncGenerator<unknown> {
  const kwargs = run.kwargs;
  const graphId = kwargs.config.configurable?.graph_id;

  if (!graphId || typeof graphId !== "string") {
    throw new Error("Invalid or missing graph_id");
  }

  const graph = getGraph(graphId, {
    checkpointer: kwargs.temporary ? null : undefined,
  });

  const libStreamMode: Set<LangGraphStreamMode> = new Set(
    kwargs.stream_mode?.filter((mode) => mode !== "events") ?? []
  );

  if (!libStreamMode.has("debug")) libStreamMode.add("debug");

  yield { type: "metadata", value: { run_id: run.run_id, attempt } };

  const metadata = {
    ...kwargs.config?.metadata,
    run_attempt: attempt,
    // TODO: get langgraph version from NPM / load.hooks.mjs
    langgraph_version: "0.2.35",
    langgraph_plan: "developer",
    langgraph_host: "self-hosted",
  };

  const events = graph.streamEvents(
    kwargs.command != null ? getLangGraphCommand(kwargs.command) : kwargs.input,
    {
      version: "v2",

      interruptAfter: kwargs.interrupt_after,
      interruptBefore: kwargs.interrupt_before,

      tags: kwargs.config.tags,
      configurable: kwargs.config.configurable,
      recursionLimit: kwargs.config.recursion_limit,
      subgraphs: kwargs.subgraphs,
      metadata,

      runId: run.run_id,
      streamMode: [...libStreamMode],
    }
  );

  for await (const event of events) {
    if (event.tags?.includes("langsmith:hidden")) continue;
    // TODO: handle if we need to filter events?
    yield event;
  }
}

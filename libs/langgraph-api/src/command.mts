import { Command, Send } from "@langchain/langgraph";

export interface RunSend {
  node: string;
  input?: unknown;
}

export interface RunCommand {
  goto?: string | RunSend | Array<RunSend | string>;
  update?: Record<string, unknown> | [string, unknown][];
  resume?: unknown;
}

export const getLangGraphCommand = (command: RunCommand) => {
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

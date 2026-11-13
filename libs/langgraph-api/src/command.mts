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

// LangGraph resumes interrupts by id only when every key of the resume map
// has this shape; any other key makes the whole map one answer.
const INTERRUPT_ID_RE = /^[0-9a-f]{32}$/;

/**
 * Whether LangGraph resumes `value` per interrupt rather than as one answer.
 */
export const isKeyedByInterruptId = (
  value: unknown
): value is Record<string, unknown> =>
  typeof value === "object" &&
  value != null &&
  !Array.isArray(value) &&
  Object.keys(value).length > 0 &&
  Object.keys(value).every((key) => INTERRUPT_ID_RE.test(key));

export const getLangGraphCommand = (command: RunCommand) => {
  const goto =
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

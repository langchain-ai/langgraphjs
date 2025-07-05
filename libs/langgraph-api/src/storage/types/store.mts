import { Run } from "./run.mjs";
import { Thread } from "./thread.mjs";
import { Assistant } from "./assistant.mjs";
import { AssistantVersion } from "./assistantVersion.mjs";

export interface Store {
  runs: Record<string, Run>;
  threads: Record<string, Thread>;
  assistants: Record<string, Assistant>;
  assistant_versions: Record<string, AssistantVersion>;
  retry_counter: Record<string, number>;
}

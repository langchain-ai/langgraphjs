import type { StreamMode } from "../../storage/types.mjs";

export const PROTOCOL_VERSION = "0.3.0";

export const DEFAULT_PROTOCOL_STREAM_MODES: StreamMode[] = [
  "values",
  "updates",
  "messages",
  "tools",
  "custom",
  "debug",
  "checkpoints",
  "tasks",
];

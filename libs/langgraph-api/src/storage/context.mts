// Hono context helpers for accessing repositories, etc.

import { getContext } from "hono/context-storage";
import type { StorageEnv } from "./types.mjs";

export const assistants = () => {
  return getContext<StorageEnv>().var.LANGGRAPH_OPS.assistants;
};

export const runs = () => {
  return getContext<StorageEnv>().var.LANGGRAPH_OPS.runs;
};

export const threads = () => {
  return getContext<StorageEnv>().var.LANGGRAPH_OPS.threads;
};

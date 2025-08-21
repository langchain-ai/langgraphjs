// Hono context helpers for accessing repositories, etc.

import { getContext } from "hono/context-storage";
import type { StorageEnv } from "./types.mjs";

export const assistants = () => {
  return getContext<StorageEnv>().var.ops.assistants;
};

export const runs = () => {
  return getContext<StorageEnv>().var.ops.runs;
};

export const threads = () => {
  return getContext<StorageEnv>().var.ops.threads;
};

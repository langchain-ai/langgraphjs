import { z } from "zod";
import type { Checkpoint, RunnableConfig } from "../storage/ops.mjs";

const ConfigSchema = z.object({
  configurable: z.object({
    thread_id: z.string(),
    checkpoint_id: z.string(),
    checkpoint_ns: z.string().nullish(),
    checkpoint_map: z.record(z.string(), z.unknown()).nullish(),
  }),
});

export const runnableConfigToCheckpoint = (
  config: RunnableConfig | null | undefined,
): Checkpoint | null => {
  if (!config || !config.configurable || !config.configurable.thread_id) {
    return null;
  }

  const parsed = ConfigSchema.safeParse(config);
  if (!parsed.success) return null;

  return {
    thread_id: parsed.data.configurable.thread_id,
    checkpoint_id: parsed.data.configurable.checkpoint_id,
    checkpoint_ns: parsed.data.configurable.checkpoint_ns || "",
    checkpoint_map: parsed.data.configurable.checkpoint_map || null,
  };
};

const TaskConfigSchema = z.object({
  configurable: z.object({
    thread_id: z.string(),
    checkpoint_id: z.string().nullish(),
    checkpoint_ns: z.string().nullish(),
    checkpoint_map: z.record(z.string(), z.unknown()).nullish(),
  }),
});

export const taskRunnableConfigToCheckpoint = (
  config: RunnableConfig | null | undefined,
): Partial<Checkpoint> | null => {
  if (!config || !config.configurable || !config.configurable.thread_id) {
    return null;
  }

  const parsed = TaskConfigSchema.safeParse(config);
  if (!parsed.success) return null;

  return {
    thread_id: parsed.data.configurable.thread_id,
    checkpoint_id: parsed.data.configurable.checkpoint_id || null,
    checkpoint_ns: parsed.data.configurable.checkpoint_ns || "",
    checkpoint_map: parsed.data.configurable.checkpoint_map || null,
  };
};

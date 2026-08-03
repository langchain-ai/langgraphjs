import { z } from "zod/v3";
import type { Checkpoint, RunnableConfig } from "../storage/types.mjs";

/**
 * Drop keys whose value is `undefined`.
 *
 * Pregel merges invoke/stream options roughly as:
 * `{ recursionLimit: this.config?.recursionLimit, ...options }`.
 * An explicit `recursionLimit: undefined` (e.g. from
 * `kwargs.config?.recursion_limit` when the run omits it) overwrites the
 * graph's `withConfig` default and falls back to langchain-core's 25.
 *
 * Keys whose value type cannot be `undefined` stay required so call sites
 * preserve discriminators like `version: "v2" | "v3"` for streamEvents.
 */
type OmitUndefinedKeys<T> = {
  [K in keyof T as undefined extends T[K] ? never : K]: Exclude<
    T[K],
    undefined
  >;
} & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<
    T[K],
    undefined
  >;
};

export function omitUndefined<T extends Record<string, unknown>>(
  obj: T
): OmitUndefinedKeys<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, value]) => value !== undefined)
  ) as OmitUndefinedKeys<T>;
}

const ConfigSchema = z.object({
  configurable: z.object({
    thread_id: z.string(),
    checkpoint_id: z.string(),
    checkpoint_ns: z.string().nullish(),
    checkpoint_map: z.record(z.string(), z.unknown()).nullish(),
  }),
});

export const runnableConfigToCheckpoint = (
  config: RunnableConfig | null | undefined
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
  config: RunnableConfig | null | undefined
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

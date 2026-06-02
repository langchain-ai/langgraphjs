import { v7 as uuidv7 } from "uuid";
import { z } from "zod/v3";

import type { MultitaskStrategy, Run } from "../../storage/types.mjs";
import * as schemas from "../../schemas.mjs";
import type { RunStatus } from "./types.mjs";

export const ProtocolCommandSchema = z.object({
  id: z.number().int().nonnegative(),
  method: z.string(),
  params: z.record(z.unknown()).optional(),
});

export const ThreadIdSchema = z.object({ thread_id: z.string() });

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export function createStubRun(
  threadId: string,
  payload: z.infer<typeof schemas.RunCreate>,
  overrides?: { status?: RunStatus; multitask_strategy?: MultitaskStrategy }
): Run {
  const now = new Date();
  const runId = uuidv7();

  let streamMode = Array.isArray(payload.stream_mode)
    ? payload.stream_mode
    : payload.stream_mode
      ? [payload.stream_mode]
      : undefined;

  if (streamMode == null || streamMode.length === 0) streamMode = ["values"];
  const config = Object.assign(
    {},
    payload.config ?? {},
    {
      configurable: {
        ...payload.config?.configurable,
        run_id: runId,
        thread_id: threadId,
        graph_id: payload.assistant_id,
        ...(payload.checkpoint_id
          ? { checkpoint_id: payload.checkpoint_id }
          : null),
        ...payload.checkpoint,
        ...(payload.langsmith_tracer
          ? {
              langsmith_project: payload.langsmith_tracer.project_name,
              langsmith_example_id: payload.langsmith_tracer.example_id,
            }
          : null),
      },
    },
    { metadata: payload.metadata ?? {} }
  );

  return {
    run_id: runId,
    thread_id: threadId,
    assistant_id: payload.assistant_id,
    metadata: payload.metadata ?? {},
    status: overrides?.status ?? "running",
    kwargs: {
      input: payload.input,
      command: payload.command,
      config,
      context: payload.context,
      stream_mode: streamMode,
      interrupt_before: payload.interrupt_before,
      interrupt_after: payload.interrupt_after,
      feedback_keys: payload.feedback_keys,
      subgraphs: payload.stream_subgraphs,
      temporary: false,
    },
    multitask_strategy: (overrides?.multitask_strategy ??
      payload.multitask_strategy ??
      "reject") as MultitaskStrategy,
    created_at: now,
    updated_at: now,
  };
}

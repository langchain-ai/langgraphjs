import {
  CancelAction,
  DefaultValues,
  Run,
  RunSelectField,
  RunStatus,
  ThreadState,
} from "../../schema.js";
import type {
  RunsCreatePayload,
  RunsStreamPayload,
  RunsWaitPayload,
  StreamEvent,
} from "../../types.js";
import type { StreamMode, TypedAsyncGenerator } from "../../types.stream.js";

import { BaseClient, getRunMetadataFromResponse } from "../base.js";

export class RunsClient<
  TStateType = DefaultValues,
  TUpdateType = TStateType,
  TCustomEventType = unknown,
> extends BaseClient {
  stream<
    TStreamMode extends StreamMode | StreamMode[] = StreamMode,
    TSubgraphs extends boolean = false,
  >(
    threadId: null,
    assistantId: string,
    payload?: Omit<
      RunsStreamPayload<TStreamMode, TSubgraphs>,
      "multitaskStrategy" | "onCompletion"
    >
  ): TypedAsyncGenerator<
    TStreamMode,
    TSubgraphs,
    TStateType,
    TUpdateType,
    TCustomEventType
  >;

  stream<
    TStreamMode extends StreamMode | StreamMode[] = StreamMode,
    TSubgraphs extends boolean = false,
  >(
    threadId: string,
    assistantId: string,
    payload?: RunsStreamPayload<TStreamMode, TSubgraphs>
  ): TypedAsyncGenerator<
    TStreamMode,
    TSubgraphs,
    TStateType,
    TUpdateType,
    TCustomEventType
  >;

  /**
   * Create a run and stream the results.
   *
   * @param threadId The ID of the thread.
   * @param assistantId Assistant ID to use for this run.
   * @param payload Payload for creating a run.
   */
  async *stream<
    TStreamMode extends StreamMode | StreamMode[] = StreamMode,
    TSubgraphs extends boolean = false,
  >(
    threadId: string | null,
    assistantId: string,
    payload?: RunsStreamPayload<TStreamMode, TSubgraphs>
  ): TypedAsyncGenerator<
    TStreamMode,
    TSubgraphs,
    TStateType,
    TUpdateType,
    TCustomEventType
  > {
    const json: Record<string, unknown> = {
      input: payload?.input,
      command: payload?.command,
      config: payload?.config,
      context: payload?.context,
      metadata: payload?.metadata,
      stream_mode: payload?.streamMode,
      stream_subgraphs: payload?.streamSubgraphs,
      stream_resumable: payload?.streamResumable,
      feedback_keys: payload?.feedbackKeys,
      assistant_id: assistantId,
      interrupt_before: payload?.interruptBefore,
      interrupt_after: payload?.interruptAfter,
      checkpoint: payload?.checkpoint,
      webhook: payload?.webhook,
      multitask_strategy: payload?.multitaskStrategy,
      on_completion: payload?.onCompletion,
      on_disconnect: payload?.onDisconnect,
      after_seconds: payload?.afterSeconds,
      if_not_exists: payload?.ifNotExists,
      checkpoint_during: payload?.checkpointDuring,
      durability: payload?.durability,
    };

    yield* this.streamWithRetry({
      endpoint:
        threadId == null ? `/runs/stream` : `/threads/${threadId}/runs/stream`,
      method: "POST",
      json,
      signal: payload?.signal,
      onInitialResponse: (response) => {
        const runMetadata = getRunMetadataFromResponse(response);
        if (runMetadata) payload?.onRunCreated?.(runMetadata);
      },
    }) as TypedAsyncGenerator<
      TStreamMode,
      TSubgraphs,
      TStateType,
      TUpdateType,
      TCustomEventType
    >;
  }

  /**
   * Create a run.
   *
   * @param threadId The ID of the thread.
   * @param assistantId Assistant ID to use for this run.
   * @param payload Payload for creating a run.
   * @returns The created run.
   */
  async create(
    threadId: string | null,
    assistantId: string,
    payload?: RunsCreatePayload
  ): Promise<Run> {
    const json: Record<string, unknown> = {
      input: payload?.input,
      command: payload?.command,
      config: payload?.config,
      context: payload?.context,
      metadata: payload?.metadata,
      stream_mode: payload?.streamMode,
      stream_subgraphs: payload?.streamSubgraphs,
      stream_resumable: payload?.streamResumable,
      feedback_keys: payload?.feedbackKeys,
      assistant_id: assistantId,
      interrupt_before: payload?.interruptBefore,
      interrupt_after: payload?.interruptAfter,
      webhook: payload?.webhook,
      checkpoint: payload?.checkpoint,
      checkpoint_id: payload?.checkpointId,
      multitask_strategy: payload?.multitaskStrategy,
      after_seconds: payload?.afterSeconds,
      if_not_exists: payload?.ifNotExists,
      checkpoint_during: payload?.checkpointDuring,
      durability: payload?.durability,
      on_completion: payload?.onCompletion,
      langsmith_tracer: payload?._langsmithTracer
        ? {
            project_name: payload?._langsmithTracer?.projectName,
            example_id: payload?._langsmithTracer?.exampleId,
          }
        : undefined,
    };

    const endpoint = threadId === null ? "/runs" : `/threads/${threadId}/runs`;
    const [run, response] = await this.fetch<Run>(endpoint, {
      method: "POST",
      json,
      signal: payload?.signal,
      withResponse: true,
    });

    const runMetadata = getRunMetadataFromResponse(response);
    if (runMetadata) payload?.onRunCreated?.(runMetadata);

    return run;
  }

  /**
   * Create a batch of stateless background runs.
   *
   * @param payloads An array of payloads for creating runs.
   * @returns An array of created runs.
   */
  async createBatch(
    payloads: (Omit<RunsCreatePayload, "signal"> & { assistantId: string })[],
    options?: { signal?: AbortSignal }
  ): Promise<Run[]> {
    const filteredPayloads = payloads
      .map((payload) => ({ ...payload, assistant_id: payload.assistantId }))
      .map((payload) => {
        return Object.fromEntries(
          Object.entries(payload).filter(([_, v]) => v !== undefined)
        );
      });

    return this.fetch<Run[]>("/runs/batch", {
      method: "POST",
      json: filteredPayloads,
      signal: options?.signal,
    });
  }

  async wait(
    threadId: null,
    assistantId: string,
    payload?: Omit<RunsWaitPayload, "multitaskStrategy" | "onCompletion">
  ): Promise<ThreadState["values"]>;

  async wait(
    threadId: string,
    assistantId: string,
    payload?: RunsWaitPayload
  ): Promise<ThreadState["values"]>;

  /**
   * Create a run and wait for it to complete.
   *
   * @param threadId The ID of the thread.
   * @param assistantId Assistant ID to use for this run.
   * @param payload Payload for creating a run.
   * @returns The last values chunk of the thread.
   */
  async wait(
    threadId: string | null,
    assistantId: string,
    payload?: RunsWaitPayload
  ): Promise<ThreadState["values"]> {
    const json: Record<string, unknown> = {
      input: payload?.input,
      command: payload?.command,
      config: payload?.config,
      context: payload?.context,
      metadata: payload?.metadata,
      assistant_id: assistantId,
      interrupt_before: payload?.interruptBefore,
      interrupt_after: payload?.interruptAfter,
      checkpoint: payload?.checkpoint,
      checkpoint_id: payload?.checkpointId,
      webhook: payload?.webhook,
      multitask_strategy: payload?.multitaskStrategy,
      on_completion: payload?.onCompletion,
      on_disconnect: payload?.onDisconnect,
      after_seconds: payload?.afterSeconds,
      if_not_exists: payload?.ifNotExists,
      checkpoint_during: payload?.checkpointDuring,
      durability: payload?.durability,
      langsmith_tracer: payload?._langsmithTracer
        ? {
            project_name: payload?._langsmithTracer?.projectName,
            example_id: payload?._langsmithTracer?.exampleId,
          }
        : undefined,
    };
    const endpoint =
      threadId == null ? `/runs/wait` : `/threads/${threadId}/runs/wait`;
    const [run, response] = await this.fetch<ThreadState["values"]>(endpoint, {
      method: "POST",
      json,
      timeoutMs: null,
      signal: payload?.signal,
      withResponse: true,
    });

    const runMetadata = getRunMetadataFromResponse(response);
    if (runMetadata) payload?.onRunCreated?.(runMetadata);

    const raiseError =
      payload?.raiseError !== undefined ? payload.raiseError : true;
    if (
      raiseError &&
      "__error__" in run &&
      typeof run.__error__ === "object" &&
      run.__error__ &&
      "error" in run.__error__ &&
      "message" in run.__error__
    ) {
      throw new Error(`${run.__error__?.error}: ${run.__error__?.message}`);
    }
    return run;
  }

  /**
   * List all runs for a thread.
   *
   * @param threadId The ID of the thread.
   * @param options Filtering and pagination options.
   * @returns List of runs.
   */
  async list(
    threadId: string,
    options?: {
      limit?: number;
      offset?: number;
      status?: RunStatus;
      select?: RunSelectField[];
      signal?: AbortSignal;
    }
  ): Promise<Run[]> {
    return this.fetch<Run[]>(`/threads/${threadId}/runs`, {
      params: {
        limit: options?.limit ?? 10,
        offset: options?.offset ?? 0,
        status: options?.status ?? undefined,
        select: options?.select ?? undefined,
      },
      signal: options?.signal,
    });
  }

  /**
   * Get a run by ID.
   *
   * @param threadId The ID of the thread.
   * @param runId The ID of the run.
   * @returns The run.
   */
  async get(
    threadId: string,
    runId: string,
    options?: { signal?: AbortSignal }
  ): Promise<Run> {
    return this.fetch<Run>(`/threads/${threadId}/runs/${runId}`, {
      signal: options?.signal,
    });
  }

  /**
   * Cancel a run.
   *
   * @param threadId The ID of the thread.
   * @param runId The ID of the run.
   * @param wait Whether to block when canceling
   * @param action Action to take when cancelling the run. Possible values are `interrupt` or `rollback`. Default is `interrupt`.
   * @returns
   */
  async cancel(
    threadId: string,
    runId: string,
    wait: boolean = false,
    action: CancelAction = "interrupt",
    options: { signal?: AbortSignal } = {}
  ): Promise<void> {
    return this.fetch<void>(`/threads/${threadId}/runs/${runId}/cancel`, {
      method: "POST",
      params: { wait: wait ? "1" : "0", action },
      signal: options?.signal,
    });
  }

  /**
   * Cancel one or more runs.
   *
   * @param options Options for cancelling runs.
   * @returns
   */
  async cancelMany(options: {
    threadId?: string;
    runIds?: string[];
    status?: "pending" | "running" | "all";
    action?: CancelAction;
    signal?: AbortSignal;
  }): Promise<void> {
    return this.fetch<void>(`/runs/cancel`, {
      method: "POST",
      json: {
        thread_id: options.threadId,
        run_ids: options.runIds,
        status: options.status,
      },
      params: { action: options.action },
      signal: options.signal,
    });
  }

  /**
   * Block until a run is done.
   *
   * @param threadId The ID of the thread.
   * @param runId The ID of the run.
   * @returns
   */
  async join(
    threadId: string,
    runId: string,
    options?: { cancelOnDisconnect?: boolean; signal?: AbortSignal }
  ): Promise<TStateType> {
    return this.fetch<TStateType>(`/threads/${threadId}/runs/${runId}/join`, {
      timeoutMs: null,
      params: { cancel_on_disconnect: options?.cancelOnDisconnect ? "1" : "0" },
      signal: options?.signal,
    });
  }

  /**
   * Stream output from a run in real-time, until the run is done.
   *
   * @param threadId The ID of the thread.
   * @param runId The ID of the run.
   * @param options Additional options for controlling the stream behavior.
   * @returns An async generator yielding stream parts.
   */
  async *joinStream(
    threadId: string | undefined | null,
    runId: string,
    options?:
      | {
          signal?: AbortSignal;
          cancelOnDisconnect?: boolean;
          lastEventId?: string;
          streamMode?: StreamMode | StreamMode[];
        }
      | AbortSignal
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): AsyncGenerator<{ id?: string; event: StreamEvent; data: any }> {
    const opts =
      typeof options === "object" &&
      options != null &&
      // eslint-disable-next-line no-instanceof/no-instanceof
      options instanceof AbortSignal
        ? { signal: options }
        : options;

    yield* this.streamWithRetry({
      endpoint:
        threadId != null
          ? `/threads/${threadId}/runs/${runId}/stream`
          : `/runs/${runId}/stream`,
      method: "GET",
      signal: opts?.signal,
      headers: opts?.lastEventId
        ? { "Last-Event-ID": opts.lastEventId }
        : undefined,
      params: {
        cancel_on_disconnect: opts?.cancelOnDisconnect ? "1" : "0",
        stream_mode: opts?.streamMode,
      },
    });
  }

  /**
   * Delete a run.
   *
   * @param threadId The ID of the thread.
   * @param runId The ID of the run.
   * @returns
   */
  async delete(
    threadId: string,
    runId: string,
    options?: { signal?: AbortSignal }
  ): Promise<void> {
    return this.fetch<void>(`/threads/${threadId}/runs/${runId}`, {
      method: "DELETE",
      signal: options?.signal,
    });
  }
}

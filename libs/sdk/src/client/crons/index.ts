import {
  Cron,
  CronSelectField,
  CronCreateForThreadResponse,
  CronCreateResponse,
  CronSortBy,
  Metadata,
  SortOrder,
} from "../../schema.js";
import type { CronsCreatePayload, CronsUpdatePayload } from "../../types.js";
import { BaseClient } from "../base.js";

export class CronsClient extends BaseClient {
  /**
   *
   * @param threadId The ID of the thread.
   * @param assistantId Assistant ID to use for this cron job.
   * @param payload Payload for creating a cron job.
   * @returns The created background run.
   */
  async createForThread(
    threadId: string,
    assistantId: string,
    payload?: CronsCreatePayload
  ): Promise<CronCreateForThreadResponse> {
    const json: Record<string, unknown> = {
      schedule: payload?.schedule,
      input: payload?.input,
      config: payload?.config,
      context: payload?.context,
      metadata: payload?.metadata,
      assistant_id: assistantId,
      interrupt_before: payload?.interruptBefore,
      interrupt_after: payload?.interruptAfter,
      webhook: payload?.webhook,
      multitask_strategy: payload?.multitaskStrategy,
      checkpoint_during: payload?.checkpointDuring,
      durability: payload?.durability,
      enabled: payload?.enabled,
      timezone: payload?.timezone,
      stream_mode: payload?.streamMode,
      stream_subgraphs: payload?.streamSubgraphs,
      stream_resumable: payload?.streamResumable,
      end_time: payload?.endTime,
      on_run_completed: payload?.onRunCompleted,
    };
    return this.fetch<CronCreateForThreadResponse>(
      `/threads/${threadId}/runs/crons`,
      {
        method: "POST",
        json,
        signal: payload?.signal,
      }
    );
  }

  /**
   *
   * @param assistantId Assistant ID to use for this cron job.
   * @param payload Payload for creating a cron job.
   * @returns
   */
  async create(
    assistantId: string,
    payload?: CronsCreatePayload
  ): Promise<CronCreateResponse> {
    const json: Record<string, unknown> = {
      schedule: payload?.schedule,
      input: payload?.input,
      config: payload?.config,
      context: payload?.context,
      metadata: payload?.metadata,
      assistant_id: assistantId,
      interrupt_before: payload?.interruptBefore,
      interrupt_after: payload?.interruptAfter,
      webhook: payload?.webhook,
      on_run_completed: payload?.onRunCompleted,
      multitask_strategy: payload?.multitaskStrategy,
      checkpoint_during: payload?.checkpointDuring,
      durability: payload?.durability,
      enabled: payload?.enabled,
      timezone: payload?.timezone,
      stream_mode: payload?.streamMode,
      stream_subgraphs: payload?.streamSubgraphs,
      stream_resumable: payload?.streamResumable,
      end_time: payload?.endTime,
    };
    return this.fetch<CronCreateResponse>(`/runs/crons`, {
      method: "POST",
      json,
      signal: payload?.signal,
    });
  }

  /**
   * Update a cron job by ID.
   *
   * @param cronId The cron ID to update.
   * @param payload Payload for updating a cron job.
   * @returns The updated cron job.
   * ```
   */
  async update(cronId: string, payload?: CronsUpdatePayload): Promise<Cron> {
    const json: Record<string, unknown> = {
      schedule: payload?.schedule,
      timezone: payload?.timezone,
      // `null` clears a set end time; `undefined` (omitted) leaves it unchanged.
      end_time: payload?.endTime,
      input: payload?.input,
      metadata: payload?.metadata,
      config: payload?.config,
      context: payload?.context,
      webhook: payload?.webhook,
      interrupt_before: payload?.interruptBefore,
      interrupt_after: payload?.interruptAfter,
      on_run_completed: payload?.onRunCompleted,
      enabled: payload?.enabled,
      stream_mode: payload?.streamMode,
      stream_subgraphs: payload?.streamSubgraphs,
      stream_resumable: payload?.streamResumable,
      durability: payload?.durability,
    };

    return this.fetch<Cron>(`/runs/crons/${cronId}`, {
      method: "PATCH",
      json,
      signal: payload?.signal,
    });
  }

  /**
   * Delete a cron job by ID.
   *
   * @param cronId Cron ID of Cron job to delete.
   * @param options Optional parameters for the request.
   */
  async delete(
    cronId: string,
    options?: { signal?: AbortSignal }
  ): Promise<void> {
    await this.fetch<void>(`/runs/crons/${cronId}`, {
      method: "DELETE",
      signal: options?.signal,
    });
  }

  /**
   *
   * @param query Query options.
   * @param query.metadata Metadata to filter by. Exact match filter for each KV pair.
   *   Available in Agent Server version 0.9.0 and later.
   * @returns List of crons.
   */
  async search(query?: {
    assistantId?: string;
    threadId?: string;
    enabled?: boolean;
    limit?: number;
    offset?: number;
    sortBy?: CronSortBy;
    sortOrder?: SortOrder;
    select?: CronSelectField[];
    metadata?: Metadata;
    signal?: AbortSignal;
  }): Promise<Cron[]> {
    return this.fetch<Cron[]>("/runs/crons/search", {
      method: "POST",
      json: {
        assistant_id: query?.assistantId ?? undefined,
        thread_id: query?.threadId ?? undefined,
        enabled: query?.enabled ?? undefined,
        limit: query?.limit ?? 10,
        offset: query?.offset ?? 0,
        sort_by: query?.sortBy ?? undefined,
        sort_order: query?.sortOrder ?? undefined,
        select: query?.select ?? undefined,
        metadata: query?.metadata ?? undefined,
      },
      signal: query?.signal,
    });
  }

  /**
   * Count cron jobs matching filters.
   *
   * @param query.assistantId Assistant ID to filter by.
   * @param query.threadId Thread ID to filter by.
   * @param query.metadata Metadata to filter by. Exact match filter for each KV pair.
   *   Available in Agent Server version 0.9.0 and later.
   * @returns Number of cron jobs matching the criteria.
   */
  async count(query?: {
    assistantId?: string;
    threadId?: string;
    metadata?: Metadata;
    signal?: AbortSignal;
  }): Promise<number> {
    return this.fetch<number>(`/runs/crons/count`, {
      method: "POST",
      json: {
        assistant_id: query?.assistantId ?? undefined,
        thread_id: query?.threadId ?? undefined,
        metadata: query?.metadata ?? undefined,
      },
      signal: query?.signal,
    });
  }
}

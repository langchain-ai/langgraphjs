import {
  Cron,
  CronSelectField,
  CronCreateForThreadResponse,
  CronCreateResponse,
  CronSortBy,
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
    const json: Record<string, unknown> = {};

    if (payload?.schedule !== undefined) {
      json.schedule = payload.schedule;
    }
    if (payload?.timezone !== undefined) {
      json.timezone = payload.timezone;
    }
    if (payload?.endTime !== undefined) {
      json.end_time = payload.endTime;
    }
    if (payload?.input !== undefined) {
      json.input = payload.input;
    }
    if (payload?.metadata !== undefined) {
      json.metadata = payload.metadata;
    }
    if (payload?.config !== undefined) {
      json.config = payload.config;
    }
    if (payload?.context !== undefined) {
      json.context = payload.context;
    }
    if (payload?.webhook !== undefined) {
      json.webhook = payload.webhook;
    }
    if (payload?.interruptBefore !== undefined) {
      json.interrupt_before = payload.interruptBefore;
    }
    if (payload?.interruptAfter !== undefined) {
      json.interrupt_after = payload.interruptAfter;
    }
    if (payload?.onRunCompleted !== undefined) {
      json.on_run_completed = payload.onRunCompleted;
    }
    if (payload?.enabled !== undefined) {
      json.enabled = payload.enabled;
    }
    if (payload?.streamMode !== undefined) {
      json.stream_mode = payload.streamMode;
    }
    if (payload?.streamSubgraphs !== undefined) {
      json.stream_subgraphs = payload.streamSubgraphs;
    }
    if (payload?.streamResumable !== undefined) {
      json.stream_resumable = payload.streamResumable;
    }
    if (payload?.durability !== undefined) {
      json.durability = payload.durability;
    }

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
      },
      signal: query?.signal,
    });
  }

  /**
   * Count cron jobs matching filters.
   *
   * @param query.assistantId Assistant ID to filter by.
   * @param query.threadId Thread ID to filter by.
   * @returns Number of cron jobs matching the criteria.
   */
  async count(query?: {
    assistantId?: string;
    threadId?: string;
    signal?: AbortSignal;
  }): Promise<number> {
    return this.fetch<number>(`/runs/crons/count`, {
      method: "POST",
      json: {
        assistant_id: query?.assistantId ?? undefined,
        thread_id: query?.threadId ?? undefined,
      },
      signal: query?.signal,
    });
  }
}

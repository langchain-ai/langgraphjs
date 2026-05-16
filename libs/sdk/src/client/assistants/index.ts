import {
  Assistant,
  AssistantGraph,
  AssistantSortBy,
  AssistantSelectField,
  AssistantVersion,
  AssistantsSearchResponse,
  Config,
  GraphSchema,
  Metadata,
  SortOrder,
  Subgraphs,
} from "../../schema.js";
import type { OnConflictBehavior } from "../../types.js";
import { BaseClient } from "../base.js";

export class AssistantsClient extends BaseClient {
  /**
   * Get an assistant by ID.
   *
   * @param assistantId The ID of the assistant.
   * @returns Assistant
   */
  async get(
    assistantId: string,
    options?: { signal?: AbortSignal }
  ): Promise<Assistant> {
    return this.fetch<Assistant>(`/assistants/${assistantId}`, {
      signal: options?.signal,
    });
  }

  /**
   * Get the JSON representation of the graph assigned to a runnable
   * @param assistantId The ID of the assistant.
   * @param options.xray Whether to include subgraphs in the serialized graph representation. If an integer value is provided, only subgraphs with a depth less than or equal to the value will be included.
   * @returns Serialized graph
   */
  async getGraph(
    assistantId: string,
    options?: { xray?: boolean | number; signal?: AbortSignal }
  ): Promise<AssistantGraph> {
    return this.fetch<AssistantGraph>(`/assistants/${assistantId}/graph`, {
      params: { xray: options?.xray },
      signal: options?.signal,
    });
  }

  /**
   * Get the state and config schema of the graph assigned to a runnable
   * @param assistantId The ID of the assistant.
   * @returns Graph schema
   */
  async getSchemas(
    assistantId: string,
    options?: { signal?: AbortSignal }
  ): Promise<GraphSchema> {
    return this.fetch<GraphSchema>(`/assistants/${assistantId}/schemas`, {
      signal: options?.signal,
    });
  }

  /**
   * Get the schemas of an assistant by ID.
   *
   * @param assistantId The ID of the assistant to get the schema of.
   * @param options Additional options for getting subgraphs, such as namespace or recursion extraction.
   * @returns The subgraphs of the assistant.
   */
  async getSubgraphs(
    assistantId: string,
    options?: {
      namespace?: string;
      recurse?: boolean;
      signal?: AbortSignal;
    }
  ): Promise<Subgraphs> {
    if (options?.namespace) {
      return this.fetch<Subgraphs>(
        `/assistants/${assistantId}/subgraphs/${options.namespace}`,
        { params: { recurse: options?.recurse }, signal: options?.signal }
      );
    }
    return this.fetch<Subgraphs>(`/assistants/${assistantId}/subgraphs`, {
      params: { recurse: options?.recurse },
      signal: options?.signal,
    });
  }

  /**
   * Create a new assistant.
   * @param payload Payload for creating an assistant.
   * @returns The created assistant.
   */
  async create(payload: {
    graphId: string;
    config?: Config;
    context?: unknown;
    metadata?: Metadata;
    assistantId?: string;
    ifExists?: OnConflictBehavior;
    name?: string;
    description?: string;
    signal?: AbortSignal;
  }): Promise<Assistant> {
    return this.fetch<Assistant>("/assistants", {
      method: "POST",
      json: {
        graph_id: payload.graphId,
        config: payload.config,
        context: payload.context,
        metadata: payload.metadata,
        assistant_id: payload.assistantId,
        if_exists: payload.ifExists,
        name: payload.name,
        description: payload.description,
      },
      signal: payload.signal,
    });
  }

  /**
   * Update an assistant.
   * @param assistantId ID of the assistant.
   * @param payload Payload for updating the assistant.
   * @returns The updated assistant.
   */
  async update(
    assistantId: string,
    payload: {
      graphId?: string;
      config?: Config;
      context?: unknown;
      metadata?: Metadata;
      name?: string;
      description?: string;
      signal?: AbortSignal;
    }
  ): Promise<Assistant> {
    return this.fetch<Assistant>(`/assistants/${assistantId}`, {
      method: "PATCH",
      json: {
        graph_id: payload.graphId,
        config: payload.config,
        context: payload.context,
        metadata: payload.metadata,
        name: payload.name,
        description: payload.description,
      },
      signal: payload.signal,
    });
  }

  /**
   * Delete an assistant.
   *
   * @param assistantId ID of the assistant.
   * @param deleteThreads If true, delete all threads with `metadata.assistant_id` equal to `assistantId`. Defaults to false.
   */
  async delete(
    assistantId: string,
    options?: { signal?: AbortSignal; deleteThreads?: boolean }
  ): Promise<void> {
    return this.fetch<void>(
      `/assistants/${assistantId}?delete_threads=${
        options?.deleteThreads ?? false
      }`,
      {
        method: "DELETE",
        signal: options?.signal,
      }
    );
  }

  /**
   * List assistants.
   * @param query Query options.
   * @returns List of assistants or, when includePagination is true, a mapping with the assistants and next cursor.
   */
  async search(query: {
    graphId?: string;
    name?: string;
    metadata?: Metadata;
    limit?: number;
    offset?: number;
    sortBy?: AssistantSortBy;
    sortOrder?: SortOrder;
    select?: AssistantSelectField[];
    includePagination: true;
    signal?: AbortSignal;
  }): Promise<AssistantsSearchResponse>;

  async search(query?: {
    graphId?: string;
    name?: string;
    metadata?: Metadata;
    limit?: number;
    offset?: number;
    sortBy?: AssistantSortBy;
    sortOrder?: SortOrder;
    select?: AssistantSelectField[];
    includePagination?: false;
    signal?: AbortSignal;
  }): Promise<Assistant[]>;

  async search(query?: {
    graphId?: string;
    name?: string;
    metadata?: Metadata;
    limit?: number;
    offset?: number;
    sortBy?: AssistantSortBy;
    sortOrder?: SortOrder;
    select?: AssistantSelectField[];
    includePagination?: boolean;
    signal?: AbortSignal;
  }): Promise<Assistant[] | AssistantsSearchResponse> {
    const json = {
      graph_id: query?.graphId ?? undefined,
      name: query?.name ?? undefined,
      metadata: query?.metadata ?? undefined,
      limit: query?.limit ?? 10,
      offset: query?.offset ?? 0,
      sort_by: query?.sortBy ?? undefined,
      sort_order: query?.sortOrder ?? undefined,
      select: query?.select ?? undefined,
    };
    const [assistants, response] = await this.fetch<Assistant[]>(
      "/assistants/search",
      {
        method: "POST",
        json,
        withResponse: true,
        signal: query?.signal,
      }
    );

    if (query?.includePagination) {
      const next = response.headers.get("X-Pagination-Next");
      return { assistants, next };
    }

    return assistants;
  }

  /**
   * Count assistants matching filters.
   *
   * @param query.metadata Metadata to filter by. Exact match for each key/value.
   * @param query.graphId Optional graph id to filter by.
   * @param query.name Optional name to filter by.
   * @returns Number of assistants matching the criteria.
   */
  async count(query?: {
    metadata?: Metadata;
    graphId?: string;
    name?: string;
    signal?: AbortSignal;
  }): Promise<number> {
    return this.fetch<number>(`/assistants/count`, {
      method: "POST",
      json: {
        metadata: query?.metadata ?? undefined,
        graph_id: query?.graphId ?? undefined,
        name: query?.name ?? undefined,
      },
      signal: query?.signal,
    });
  }

  /**
   * List all versions of an assistant.
   *
   * @param assistantId ID of the assistant.
   * @returns List of assistant versions.
   */
  async getVersions(
    assistantId: string,
    payload?: {
      metadata?: Metadata;
      limit?: number;
      offset?: number;
      signal?: AbortSignal;
    }
  ): Promise<AssistantVersion[]> {
    return this.fetch<AssistantVersion[]>(
      `/assistants/${assistantId}/versions`,
      {
        method: "POST",
        json: {
          metadata: payload?.metadata ?? undefined,
          limit: payload?.limit ?? 10,
          offset: payload?.offset ?? 0,
        },
        signal: payload?.signal,
      }
    );
  }

  /**
   * Change the version of an assistant.
   *
   * @param assistantId ID of the assistant.
   * @param version The version to change to.
   * @returns The updated assistant.
   */
  async setLatest(
    assistantId: string,
    version: number,
    options?: { signal?: AbortSignal }
  ): Promise<Assistant> {
    return this.fetch<Assistant>(`/assistants/${assistantId}/latest`, {
      method: "POST",
      json: { version },
      signal: options?.signal,
    });
  }
}

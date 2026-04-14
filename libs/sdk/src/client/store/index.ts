import {
  Item,
  ListNamespaceResponse,
  SearchItemsResponse,
} from "../../schema.js";
import { BaseClient } from "../base.js";

interface APIItem {
  namespace: string[];
  key: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  value: Record<string, any>;
  created_at: string;
  updated_at: string;
}
interface APISearchItemsResponse {
  items: APIItem[];
}

export class StoreClient extends BaseClient {
  /**
   * Store or update an item.
   *
   * @param namespace A list of strings representing the namespace path.
   * @param key The unique identifier for the item within the namespace.
   * @param value A dictionary containing the item's data.
   * @param options.index Controls search indexing - null (use defaults), false (disable), or list of field paths to index.
   * @param options.ttl Optional time-to-live in minutes for the item, or null for no expiration.
   * @returns Promise<void>
   */
  async putItem(
    namespace: string[],
    key: string,
    value: Record<string, unknown>,
    options?: {
      index?: false | string[] | null;
      ttl?: number | null;
      signal?: AbortSignal;
    }
  ): Promise<void> {
    namespace.forEach((label) => {
      if (label.includes(".")) {
        throw new Error(
          `Invalid namespace label '${label}'. Namespace labels cannot contain periods ('.')`
        );
      }
    });

    const payload = {
      namespace,
      key,
      value,
      index: options?.index,
      ttl: options?.ttl,
    };

    return this.fetch<void>("/store/items", {
      method: "PUT",
      json: payload,
      signal: options?.signal,
    });
  }

  /**
   * Retrieve a single item.
   *
   * @param namespace A list of strings representing the namespace path.
   * @param key The unique identifier for the item.
   * @param options.refreshTtl Whether to refresh the TTL on this read operation.
   * @returns Promise<Item>
   */
  async getItem(
    namespace: string[],
    key: string,
    options?: {
      refreshTtl?: boolean | null;
      signal?: AbortSignal;
    }
  ): Promise<Item | null> {
    namespace.forEach((label) => {
      if (label.includes(".")) {
        throw new Error(
          `Invalid namespace label '${label}'. Namespace labels cannot contain periods ('.')`
        );
      }
    });

    const params: Record<string, unknown> = {
      namespace: namespace.join("."),
      key,
    };

    if (options?.refreshTtl !== undefined) {
      params.refresh_ttl = options.refreshTtl;
    }

    const response = await this.fetch<APIItem>("/store/items", {
      params,
      signal: options?.signal,
    });

    return response
      ? {
          ...response,
          createdAt: response.created_at,
          updatedAt: response.updated_at,
        }
      : null;
  }

  /**
   * Delete an item.
   *
   * @param namespace A list of strings representing the namespace path.
   * @param key The unique identifier for the item.
   * @returns Promise<void>
   */
  async deleteItem(
    namespace: string[],
    key: string,
    options?: { signal?: AbortSignal }
  ): Promise<void> {
    namespace.forEach((label) => {
      if (label.includes(".")) {
        throw new Error(
          `Invalid namespace label '${label}'. Namespace labels cannot contain periods ('.')`
        );
      }
    });

    return this.fetch<void>("/store/items", {
      method: "DELETE",
      json: { namespace, key },
      signal: options?.signal,
    });
  }

  /**
   * Search for items within a namespace prefix.
   *
   * @param namespacePrefix List of strings representing the namespace prefix.
   * @param options Search options including filter, pagination, and query.
   * @returns Promise<SearchItemsResponse>
   */
  async searchItems(
    namespacePrefix: string[],
    options?: {
      filter?: Record<string, unknown>;
      limit?: number;
      offset?: number;
      query?: string;
      refreshTtl?: boolean | null;
      signal?: AbortSignal;
    }
  ): Promise<SearchItemsResponse> {
    const payload = {
      namespace_prefix: namespacePrefix,
      filter: options?.filter,
      limit: options?.limit ?? 10,
      offset: options?.offset ?? 0,
      query: options?.query,
      refresh_ttl: options?.refreshTtl,
    };

    const response = await this.fetch<APISearchItemsResponse>(
      "/store/items/search",
      {
        method: "POST",
        json: payload,
        signal: options?.signal,
      }
    );
    return {
      items: response.items.map((item) => ({
        ...item,
        createdAt: item.created_at,
        updatedAt: item.updated_at,
      })),
    };
  }

  /**
   * List namespaces with optional match conditions.
   *
   * @param options Filtering and pagination options for namespaces.
   * @returns Promise<ListNamespaceResponse>
   */
  async listNamespaces(options?: {
    prefix?: string[];
    suffix?: string[];
    maxDepth?: number;
    limit?: number;
    offset?: number;
    signal?: AbortSignal;
  }): Promise<ListNamespaceResponse> {
    const payload = {
      prefix: options?.prefix,
      suffix: options?.suffix,
      max_depth: options?.maxDepth,
      limit: options?.limit ?? 100,
      offset: options?.offset ?? 0,
    };

    return this.fetch<ListNamespaceResponse>("/store/namespaces", {
      method: "POST",
      json: payload,
      signal: options?.signal,
    });
  }
}

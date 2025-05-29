import { SerializerProtocol } from "../serde/base.js";
import { JsonPlusSerializer } from "../serde/jsonplus.js";

export type CacheNamespace = string[];
export type CacheFullKey = [namespace: CacheNamespace, key: string];

export abstract class BaseCache<V = unknown> {
  serde: SerializerProtocol = new JsonPlusSerializer();

  /**
   * Initialize the cache with a serializer.
   *
   * @param serde - The serializer to use.
   */
  constructor(serde?: SerializerProtocol) {
    this.serde = serde || this.serde;
  }

  /**
   * Get the cached values for the given keys.
   *
   * @param keys - The keys to get.
   */
  abstract get(
    keys: CacheFullKey[]
  ): Promise<{ key: CacheFullKey; value: V }[]>;

  /**
   * Set the cached values for the given keys and TTLs.
   *
   * @param pairs - The pairs to set.
   */
  abstract set(
    pairs: { key: CacheFullKey; value: V; ttl?: number }[]
  ): Promise<void>;

  /**
   * Delete the cached values for the given namespaces.
   * If no namespaces are provided, clear all cached values.
   *
   * @param namespaces - The namespaces to clear.
   */
  abstract clear(namespaces: CacheNamespace[]): Promise<void>;
}

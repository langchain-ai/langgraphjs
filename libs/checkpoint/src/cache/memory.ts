import { BaseCache, type CacheFullKey, type CacheNamespace } from "./base.js";

export class InMemoryCache<V = unknown> extends BaseCache<V> {
  private cache = new Map<
    string,
    Map<
      string,
      {
        enc: string;
        val: Uint8Array | string;
        exp: number | null;
      }
    >
  >();

  async get(keys: CacheFullKey[]): Promise<{ key: CacheFullKey; value: V }[]> {
    if (!keys.length) return [];
    const now = Date.now();
    return (
      await Promise.all(
        keys.map(
          async (fullKey): Promise<{ key: CacheFullKey; value: V }[]> => {
            const [namespace, key] = fullKey;
            const namespaceCache = this.cache.get(JSON.stringify(namespace));
            const cached = namespaceCache?.get(key);

            if (cached) {
              if (cached.exp == null || now < cached.exp) {
                const value = await this.serde.loadsTyped(
                  cached.enc,
                  cached.val
                );
                return [{ key: fullKey, value }];
              } else {
                namespaceCache?.delete(key);
              }
            }

            return [];
          }
        )
      )
    ).flat();
  }

  async set(
    pairs: { key: CacheFullKey; value: V; ttl?: number }[]
  ): Promise<void> {
    const now = Date.now();
    for (const { key: fullKey, value, ttl } of pairs) {
      const [namespace, key] = fullKey;
      const strNamespace = JSON.stringify(namespace);
      const [enc, val] = await this.serde.dumpsTyped(value);
      const exp = ttl != null ? ttl * 1000 + now : null;

      let namespaceCache = this.cache.get(strNamespace);
      if (!namespaceCache) {
        namespaceCache = new Map();
        this.cache.set(strNamespace, namespaceCache);
      }
      namespaceCache.set(key, { enc, val, exp });
    }
  }

  async clear(namespaces: CacheNamespace[]): Promise<void> {
    if (!namespaces.length) {
      this.cache.clear();
      return;
    }

    for (const namespace of namespaces) {
      this.cache.delete(JSON.stringify(namespace));
    }
  }
}

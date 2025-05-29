import { BaseCache, type CacheFullKey, type CacheNamespace } from "./base.js";

export class InMemoryCache<V = unknown> extends BaseCache<V> {
  private cache: {
    [namespace: string]: {
      [key: string]: {
        enc: string;
        val: Uint8Array | string;
        exp: number | null;
      };
    };
  } = {};

  async get(keys: CacheFullKey[]): Promise<{ key: CacheFullKey; value: V }[]> {
    if (!keys.length) return [];
    const now = Date.now();
    return (
      await Promise.all(
        keys.map(
          async (fullKey): Promise<{ key: CacheFullKey; value: V }[]> => {
            const [namespace, key] = fullKey;
            const strNamespace = namespace.join(",");

            if (strNamespace in this.cache && key in this.cache[strNamespace]) {
              const cached = this.cache[strNamespace][key];
              if (cached.exp == null || now < cached.exp) {
                const value = await this.serde.loadsTyped(
                  cached.enc,
                  cached.val
                );
                return [{ key: fullKey, value }];
              } else {
                delete this.cache[strNamespace][key];
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
      const strNamespace = namespace.join(",");
      const [enc, val] = await this.serde.dumpsTyped(value);
      const exp = ttl != null ? ttl * 1000 + now : null;

      this.cache[strNamespace] ??= {};
      this.cache[strNamespace][key] = { enc, val, exp };
    }
  }

  async clear(namespaces: CacheNamespace[]): Promise<void> {
    if (!namespaces.length) {
      this.cache = {};
      return;
    }

    for (const namespace of namespaces) {
      const strNamespace = namespace.join(",");
      if (strNamespace in this.cache) delete this.cache[strNamespace];
    }
  }
}

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import * as schemas from "../schemas.mjs";
import { HTTPException } from "hono/http-exception";
import { store as storageStore } from "../storage/store.mjs";
import type { Item } from "@langchain/langgraph";
import {
  handleAuthEvent,
  isAuthMatching,
  type AuthFilters,
} from "../auth/index.mjs";

const api = new Hono();
const AUTH_FILTER_SCAN_PAGE_LIMIT = 1000;
const AUTH_FILTER_MAX_SCAN_LIMIT = 10_000;

const throwStoreAuthScanLimitError = (): never => {
  throw new HTTPException(400, {
    message:
      "Authenticated store query exceeded maximum scan limit. Narrow the namespace or filters.",
  });
};

const getStoreAuthMetadata = (
  namespace: string[] | undefined,
  key?: string,
  value?: Record<string, unknown> | null
): Record<string, unknown> => ({
  ...(value ?? {}),
  namespace: namespace ?? [],
  ...(key == null ? {} : { key }),
});

const isStoreAuthMatching = (
  namespace: string[] | undefined,
  key: string | undefined,
  value: Record<string, unknown> | null | undefined,
  filters: AuthFilters
): boolean =>
  isAuthMatching(getStoreAuthMetadata(namespace, key, value), filters);

const validateNamespace = (namespace: string[]) => {
  if (!namespace || namespace.length === 0) {
    throw new HTTPException(400, { message: "Namespace is required" });
  }

  for (const label of namespace) {
    if (!label || label.includes(".")) {
      throw new HTTPException(422, {
        message:
          "Namespace labels cannot be empty or contain periods. Received: " +
          namespace.join("."),
      });
    }
  }
};

const mapItemsToApi = (item: Item | null) => {
  if (item == null) return null;

  const clonedItem: Record<string, unknown> = { ...item };
  delete clonedItem.createdAt;
  delete clonedItem.updatedAt;

  clonedItem.created_at = item.createdAt;
  clonedItem.updated_at = item.updatedAt;

  return clonedItem;
};

api.post(
  "/store/namespaces",
  zValidator("json", schemas.StoreListNamespaces),
  async (c) => {
    // List Namespaces
    const payload = c.req.valid("json");
    if (payload.prefix) validateNamespace(payload.prefix);
    if (payload.suffix) validateNamespace(payload.suffix);

    const [filters] = await handleAuthEvent(
      c.var.auth,
      "store:list_namespaces",
      {
        namespace: payload.prefix,
        suffix: payload.suffix,
        max_depth: payload.max_depth,
        limit: payload.limit,
        offset: payload.offset,
      }
    );

    const limit = payload.limit ?? 100;
    const offset = payload.offset ?? 0;
    let namespaces: string[][];
    if (filters == null) {
      namespaces = await storageStore.listNamespaces({
        limit,
        offset,
        prefix: payload.prefix,
        suffix: payload.suffix,
        maxDepth: payload.max_depth,
      });
    } else {
      const authorizedNamespaces: string[][] = [];
      const requiredCount = offset + limit;
      let scannedCount = 0;

      while (
        authorizedNamespaces.length < requiredCount &&
        scannedCount < AUTH_FILTER_MAX_SCAN_LIMIT
      ) {
        const scanLimit = Math.min(
          AUTH_FILTER_SCAN_PAGE_LIMIT,
          AUTH_FILTER_MAX_SCAN_LIMIT - scannedCount
        );
        const candidates = await storageStore.listNamespaces({
          limit: scanLimit,
          offset: scannedCount,
          prefix: payload.prefix,
          suffix: payload.suffix,
          maxDepth: payload.max_depth,
        });
        scannedCount += candidates.length;
        authorizedNamespaces.push(
          ...candidates.filter((namespace) =>
            isStoreAuthMatching(namespace, undefined, undefined, filters)
          )
        );
        if (candidates.length < scanLimit) break;
      }

      if (
        authorizedNamespaces.length < requiredCount &&
        scannedCount >= AUTH_FILTER_MAX_SCAN_LIMIT
      ) {
        throwStoreAuthScanLimitError();
      }

      namespaces = authorizedNamespaces.slice(offset, requiredCount);
    }

    return c.json({ namespaces });
  }
);

api.post(
  "/store/items/search",
  zValidator("json", schemas.StoreSearchItems),
  async (c) => {
    // Search Items
    const payload = c.req.valid("json");
    if (payload.namespace_prefix.length)
      validateNamespace(payload.namespace_prefix);

    const [filters] = await handleAuthEvent(c.var.auth, "store:search", {
      namespace: payload.namespace_prefix,
      filter: payload.filter,
      limit: payload.limit,
      offset: payload.offset,
      query: payload.query,
    });

    const limit = payload.limit ?? 10;
    const offset = payload.offset ?? 0;
    let items: Item[];
    if (filters == null) {
      items = await storageStore.search(payload.namespace_prefix, {
        filter: payload.filter,
        limit,
        offset,
        query: payload.query,
      });
    } else {
      const authorizedItems: Item[] = [];
      const requiredCount = offset + limit;
      let scannedCount = 0;

      while (
        authorizedItems.length < requiredCount &&
        scannedCount < AUTH_FILTER_MAX_SCAN_LIMIT
      ) {
        const scanLimit = Math.min(
          AUTH_FILTER_SCAN_PAGE_LIMIT,
          AUTH_FILTER_MAX_SCAN_LIMIT - scannedCount
        );
        const candidates = await storageStore.search(payload.namespace_prefix, {
          filter: payload.filter,
          limit: scanLimit,
          offset: scannedCount,
          query: payload.query,
        });
        scannedCount += candidates.length;
        authorizedItems.push(
          ...candidates.filter((item) =>
            isStoreAuthMatching(item.namespace, item.key, item.value, filters)
          )
        );
        if (candidates.length < scanLimit) break;
      }

      if (
        authorizedItems.length < requiredCount &&
        scannedCount >= AUTH_FILTER_MAX_SCAN_LIMIT
      ) {
        throwStoreAuthScanLimitError();
      }

      items = authorizedItems.slice(offset, requiredCount);
    }

    return c.json({ items: items.map(mapItemsToApi) });
  }
);

api.put("/store/items", zValidator("json", schemas.StorePutItem), async (c) => {
  // Put Item
  const payload = c.req.valid("json");
  if (payload.namespace) validateNamespace(payload.namespace);

  const [filters, mutable] = await handleAuthEvent(c.var.auth, "store:put", {
    namespace: payload.namespace,
    key: payload.key,
    value: payload.value,
  });

  if (mutable.namespace) validateNamespace(mutable.namespace);
  const existingItem = await storageStore.get(mutable.namespace, mutable.key);
  if (
    existingItem != null &&
    !isStoreAuthMatching(
      existingItem.namespace,
      existingItem.key,
      existingItem.value,
      filters
    )
  ) {
    throw new HTTPException(404, { message: "Item not found" });
  }

  if (
    !isStoreAuthMatching(mutable.namespace, mutable.key, mutable.value, filters)
  ) {
    throw new HTTPException(403, { message: "Not authorized" });
  }

  await storageStore.put(mutable.namespace, mutable.key, mutable.value);
  return c.body(null, 204);
});

api.delete(
  "/store/items",
  zValidator("json", schemas.StoreDeleteItem),
  async (c) => {
    // Delete Item
    const payload = c.req.valid("json");
    if (payload.namespace) validateNamespace(payload.namespace);

    const [filters, mutable] = await handleAuthEvent(
      c.var.auth,
      "store:delete",
      {
        namespace: payload.namespace,
        key: payload.key,
      }
    );

    const namespace = mutable.namespace ?? [];
    if (namespace.length) validateNamespace(namespace);
    const existingItem = await storageStore.get(namespace, mutable.key);
    if (existingItem != null) {
      if (
        !isStoreAuthMatching(
          existingItem.namespace,
          existingItem.key,
          existingItem.value,
          filters
        )
      ) {
        throw new HTTPException(404, { message: "Item not found" });
      }
    } else if (
      !isStoreAuthMatching(namespace, mutable.key, undefined, filters)
    ) {
      throw new HTTPException(403, { message: "Not authorized" });
    }

    await storageStore.delete(namespace, mutable.key);
    return c.body(null, 204);
  }
);

api.get(
  "/store/items",
  zValidator("query", schemas.StoreGetItem),
  async (c) => {
    // Get Item
    const payload = c.req.valid("query");

    const [filters, mutable] = await handleAuthEvent(c.var.auth, "store:get", {
      namespace: payload.namespace,
      key: payload.key,
    });

    const namespace = mutable.namespace ?? [];
    const item = await storageStore.get(namespace, mutable.key);
    if (
      item != null &&
      !isStoreAuthMatching(item.namespace, item.key, item.value, filters)
    ) {
      throw new HTTPException(404, { message: "Item not found" });
    }

    return c.json(mapItemsToApi(item));
  }
);

export default api;

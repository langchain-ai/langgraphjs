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
): boolean => isAuthMatching(getStoreAuthMetadata(namespace, key, value), filters);

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

    const [filters] = await handleAuthEvent(c.var.auth, "store:list_namespaces", {
      namespace: payload.prefix,
      suffix: payload.suffix,
      max_depth: payload.max_depth,
      limit: payload.limit,
      offset: payload.offset,
    });

    const limit = payload.limit ?? 100;
    const offset = payload.offset ?? 0;
    const namespaces = await storageStore.listNamespaces({
      limit: filters == null ? limit : undefined,
      offset: filters == null ? offset : undefined,
      prefix: payload.prefix,
      suffix: payload.suffix,
      maxDepth: payload.max_depth,
    });

    const authorizedNamespaces =
      filters == null
        ? namespaces
        : namespaces
            .filter((namespace) =>
              isStoreAuthMatching(namespace, undefined, undefined, filters)
            )
            .slice(offset, offset + limit);

    return c.json({ namespaces: authorizedNamespaces });
  }
);

api.post(
  "/store/items/search",
  zValidator("json", schemas.StoreSearchItems),
  async (c) => {
    // Search Items
    const payload = c.req.valid("json");
    if (payload.namespace_prefix.length) validateNamespace(payload.namespace_prefix);

    const [filters] = await handleAuthEvent(c.var.auth, "store:search", {
      namespace: payload.namespace_prefix,
      filter: payload.filter,
      limit: payload.limit,
      offset: payload.offset,
      query: payload.query,
    });

    const limit = payload.limit ?? 10;
    const offset = payload.offset ?? 0;
    const items = await storageStore.search(payload.namespace_prefix, {
      filter: payload.filter,
      limit: filters == null ? limit : Number.MAX_SAFE_INTEGER,
      offset: filters == null ? offset : 0,
      query: payload.query,
    });

    const authorizedItems =
      filters == null
        ? items
        : items
            .filter((item) =>
              isStoreAuthMatching(item.namespace, item.key, item.value, filters)
            )
            .slice(offset, offset + limit);

    return c.json({ items: authorizedItems.map(mapItemsToApi) });
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

    const [filters, mutable] = await handleAuthEvent(c.var.auth, "store:delete", {
      namespace: payload.namespace,
      key: payload.key,
    });

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
    } else if (!isStoreAuthMatching(namespace, mutable.key, undefined, filters)) {
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

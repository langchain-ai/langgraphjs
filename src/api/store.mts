import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import * as schemas from "../schemas.mjs";
import { HTTPException } from "hono/http-exception";
import { store as storageStore } from "../storage/store.mjs";

const api = new Hono();

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

api.post(
  "/store/namespaces",
  zValidator("json", schemas.StoreListNamespaces),
  async (c) => {
    // List Namespaces
    const payload = c.req.valid("json");
    if (payload.prefix) validateNamespace(payload.prefix);
    if (payload.suffix) validateNamespace(payload.suffix);

    return c.json({
      namespaces: await storageStore.listNamespaces({
        limit: payload.limit ?? 100,
        offset: payload.offset ?? 0,
        prefix: payload.prefix,
        suffix: payload.suffix,
        maxDepth: payload.max_depth,
      }),
    });
  }
);

api.post(
  "/store/items/search",
  zValidator("json", schemas.StoreSearchItems),
  async (c) => {
    // Search Items
    const payload = c.req.valid("json");
    if (payload.namespace_prefix) validateNamespace(payload.namespace_prefix);

    return c.json({
      items: await storageStore.search(payload.namespace_prefix, {
        filter: payload.filter,
        limit: payload.limit ?? 10,
        offset: payload.offset ?? 0,
        query: payload.query,
      }),
    });
  }
);

api.put("/store/items", zValidator("json", schemas.StorePutItem), async (c) => {
  // Put Item
  const payload = c.req.valid("json");
  if (payload.namespace) validateNamespace(payload.namespace);
  await storageStore.put(payload.namespace, payload.key, payload.value);
  return c.body(null, 204);
});

api.delete(
  "/store/items",
  zValidator("json", schemas.StoreDeleteItem),
  async (c) => {
    // Delete Item
    const payload = c.req.valid("json");
    if (payload.namespace) validateNamespace(payload.namespace);
    await storageStore.delete(payload.namespace ?? [], payload.key);
    return c.body(null, 204);
  }
);

api.get(
  "/store/items",
  zValidator("query", schemas.StoreGetItem),
  async (c) => {
    // Get Item
    const payload = c.req.valid("query");
    const key = payload.key;
    const namespace = payload.namespace;
    return c.json(await storageStore.get(namespace, key));
  }
);

export default api;

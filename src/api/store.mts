import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import * as schemas from "../validate.mts";

export const store = new Hono();

// Existing endpoints...

store.post(
  "/namespaces",
  zValidator("json", schemas.StoreListNamespaces),
  async (c) => {
    // List Namespaces
    const payload = c.req.valid("json");

    // TODO: implement namespace listing
    return c.json({
      namespaces: [],
    });
  }
);

store.post(
  "/items/search",
  zValidator("json", schemas.StoreSearchItems),
  async (c) => {
    // Search Items
    const payload = c.req.valid("json");

    // TODO: implement item search
    return c.json({
      items: [],
    });
  }
);

store.put("/items", zValidator("json", schemas.StorePutItem), async (c) => {
  // Put Item
  const payload = c.req.valid("json");

  // TODO: implement item creation/update
  return c.json({});
});

store.delete(
  "/items",
  zValidator("json", schemas.StoreDeleteItem),
  async (c) => {
    // Delete Item
    const payload = c.req.valid("json");

    // TODO: implement item deletion
    return c.json({});
  }
);

store.get("/items", async (c) => {
  // Get Item
  const key = c.req.query("key");
  const namespace = c.req.query("namespace")?.split(",");

  if (!key) {
    return c.text("Missing key parameter", 400);
  }

  // TODO: implement item retrieval
  return c.json({
    namespace: namespace || [],
    key: key,
    value: {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
});

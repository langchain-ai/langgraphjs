import { Hono } from "hono";

export const app = new Hono()
  .get("/", (c) => c.json({ name: "extension", version: "1.0.0" }))
  .get("/health", (c) => c.json({ healthy: true }))
  .post("/webhook", async (c) => {
    const body = await c.req.json();
    return c.json({ received: body });
  });

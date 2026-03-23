import { Hono } from "hono";

export const app = new Hono()
  .get("/", (c) => c.json({ name: "dashboard", status: "ok" }))
  .get("/metrics", (c) => c.json({ runs: 42, threads: 7 }));

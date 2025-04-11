import { Hono } from "hono";

export const app = new Hono().get("/info", (c) => c.json({ random: true }));

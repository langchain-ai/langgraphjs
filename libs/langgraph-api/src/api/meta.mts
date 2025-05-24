import { Hono } from "hono";

const api = new Hono();

api.get("/info", (c) => c.json({ flags: { assistants: true, crons: false } }));

api.get("/ok", (c) => c.json({ ok: true }));

export default api;

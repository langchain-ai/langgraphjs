import { serve } from "@hono/node-server";
import { Hono } from "hono";

import { logger } from "hono/logger";
import { registerFromEnv } from "./graph/load.mjs";

import runs from "./api/runs.mjs";
import threads from "./api/threads.mjs";
import assistants from "./api/assistants.mjs";
import store from "./api/store.mjs";
import { truncate } from "./storage/ops.mjs";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";

const app = new Hono();

app.use(logger());
app.route("/", assistants);
app.route("/", runs);
app.route("/", threads);
app.route("/", store);

app.post(
  "/internal/truncate",
  zValidator(
    "json",
    z.object({
      runs: z.boolean().optional(),
      threads: z.boolean().optional(),
      assistants: z.boolean().optional(),
      checkpointer: z.boolean().optional(),
      store: z.boolean().optional(),
    })
  ),
  (c) => {
    const { runs, threads, assistants, checkpointer, store } =
      c.req.valid("json");

    truncate({ runs, threads, assistants, checkpointer, store });
    return c.json({ ok: true });
  }
);

async function lifecycle() {
  await registerFromEnv();
  serve(
    {
      fetch: app.fetch,
      port: process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 9123,
    },
    (c) => console.info(`Listening to ${c.address}:${c.port}`)
  );
}

lifecycle();

import { serve } from "@hono/node-server";
import { Hono } from "hono";

import { logger } from "hono/logger";

import { registerFromEnv } from "./graph/load.mjs";

import { runs } from "./api/runs.mjs";
import { threads } from "./api/threads.mjs";
import { assistants } from "./api/assistants.mjs";
import { store } from "./api/store.mjs";
import { clear as opsClear } from "./storage/ops.mts";
import { checkpointer as localCheckpointer } from "./storage/checkpoint.mts";
import { store as localStore } from "./storage/store.mts";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";

export const app = new Hono();

app.use(logger());

app.route("/assistants", assistants);
app.route("/runs", runs);
app.route("/threads", threads);
app.route("/store", store);

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

    opsClear({ runs, threads, assistants, checkpointer, store });
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
    (c) => {
      console.info(`Listening to ${c.address}:${c.port}`);
    }
  );
}

lifecycle();

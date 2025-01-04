import { serve } from "@hono/node-server";
import { Hono } from "hono";

import { logger } from "hono/logger";

import { registerFromEnv } from "./graph/load.mjs";

import { runs } from "./api/runs.mjs";
import { threads } from "./api/threads.mjs";
import { assistants } from "./api/assistants.mjs";
import { store } from "./api/store.mjs";

export const app = new Hono();

app.use(logger());

app.route("/assistants", assistants);
app.route("/runs", runs);
app.route("/threads", threads);
app.route("/store", store);

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

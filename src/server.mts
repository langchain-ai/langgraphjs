import { serve } from "@hono/node-server";
import { Hono } from "hono";

import { logger } from "hono/logger";

import { registerFromEnv } from "./graph.mts";

import { runs } from "./models/runs.mts";
import { threads } from "./models/threads.mts";
import { assistants } from "./models/assistants.mts";

export const app = new Hono();

app.use(logger());

app.route("/assistants", assistants);
app.route("/runs", runs);
app.route("/threads", threads);

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

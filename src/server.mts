import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";

import { registerFromEnv } from "./graph/load.mjs";

import runs from "./api/runs.mjs";
import threads from "./api/threads.mjs";
import assistants from "./api/assistants.mjs";
import store from "./api/store.mjs";
import { truncate } from "./storage/ops.mjs";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { queue } from "./queue.mjs";
import { logger, requestLogger } from "./logging.mjs";
import { ConfigSchema } from "./utils/config.mjs";

const app = new Hono();

app.use(cors());
app.use(requestLogger());

app.route("/", assistants);
app.route("/", runs);
app.route("/", threads);
app.route("/", store);
app.get("/info", (c) => c.json({ flags: { assistants: true, crons: false } }));

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

const N_WORKERS = 10;

export async function startServer(options: {
  port?: number;
  nWorkers?: number;
  host?: string;
  config?: z.infer<typeof ConfigSchema>;
  cwd?: string;
}): Promise<string> {
  logger.info("Registering graphs");
  const specs =
    options.config != null
      ? options.config.graphs
      : z.record(z.string()).parse(JSON.parse(process.env.LANGSERVE_GRAPHS));

  const port =
    options.port ??
    (process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 9123);

  const hostname = options.host ?? "0.0.0.0";
  const projectDir = options.cwd ?? process.cwd();

  logger.info(`Registering graphs from ${projectDir}`);
  await registerFromEnv(specs, { cwd: projectDir });

  logger.info(`Starting ${options.nWorkers ?? N_WORKERS} workers`);
  for (let i = 0; i < (options.nWorkers ?? N_WORKERS); i++) queue();

  return new Promise((resolve) => {
    serve({ fetch: app.fetch, port, hostname }, (c) => {
      resolve(`${c.address}:${c.port}`);
    });
  });
}

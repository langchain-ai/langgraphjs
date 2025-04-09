import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";

import { registerFromEnv } from "./graph/load.mjs";

import runs from "./api/runs.mjs";
import threads from "./api/threads.mjs";
import assistants from "./api/assistants.mjs";
import store from "./api/store.mjs";

import { truncate, conn as opsConn } from "./storage/ops.mjs";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { queue } from "./queue.mjs";
import { logger, requestLogger } from "./logging.mjs";
import { checkpointer } from "./storage/checkpoint.mjs";
import { store as graphStore } from "./storage/store.mjs";
import { auth } from "./auth/custom.mjs";
import { registerAuth } from "./auth/index.mjs";

const app = new Hono();

// This is used to match the behavior of the original LangGraph API
// where the content-type is not being validated. Might be nice
// to warn about this in the future and throw an error instead.
app.use(async (c, next) => {
  if (
    c.req.header("content-type")?.startsWith("text/plain") &&
    c.req.method !== "GET" &&
    c.req.method !== "OPTIONS"
  ) {
    c.req.raw.headers.set("content-type", "application/json");
  }

  await next();
});

app.use(cors());
app.use(requestLogger());
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
    }),
  ),
  (c) => {
    const { runs, threads, assistants, checkpointer, store } =
      c.req.valid("json");

    truncate({ runs, threads, assistants, checkpointer, store });
    return c.json({ ok: true });
  },
);

app.use(auth());
app.route("/", assistants);
app.route("/", runs);
app.route("/", threads);
app.route("/", store);

export const StartServerSchema = z.object({
  port: z.number(),
  nWorkers: z.number(),
  host: z.string(),
  cwd: z.string(),
  graphs: z.record(z.string()),
  auth: z
    .object({
      path: z.string().optional(),
      disable_studio_auth: z.boolean().default(false),
    })
    .optional(),
  ui: z.record(z.string()).optional(),
  ui_config: z.object({ shared: z.array(z.string()).optional() }).optional(),
});

export async function startServer(options: z.infer<typeof StartServerSchema>) {
  logger.info(`Initializing storage...`);
  const callbacks = await Promise.all([
    opsConn.initialize(options.cwd),
    checkpointer.initialize(options.cwd),
    graphStore.initialize(options.cwd),
  ]);

  const cleanup = async () => {
    logger.info(`Flushing to persistent storage, exiting...`);
    await Promise.all(callbacks.map((c) => c.flush()));
  };

  logger.info(`Registering graphs from ${options.cwd}`);
  await registerFromEnv(options.graphs, { cwd: options.cwd });

  if (options.auth?.path) {
    logger.info(`Loading auth from ${options.auth.path}`);
    await registerAuth(options.auth, { cwd: options.cwd });
  }

  if (options.ui) {
    logger.info(`Loading UI`);
    const { api, registerGraphUi } = await import("./ui/load.mjs");
    app.route("/", api);

    logger.info(`Registering UI from ${options.cwd}`);
    await registerGraphUi(options.ui, {
      cwd: options.cwd,
      config: options.ui_config,
    });
  }

  logger.info(`Starting ${options.nWorkers} workers`);
  for (let i = 0; i < options.nWorkers; i++) queue();

  return new Promise<{ host: string; cleanup: () => Promise<void> }>(
    (resolve) => {
      serve(
        { fetch: app.fetch, port: options.port, hostname: options.host },
        (c) => {
          resolve({ host: `${c.address}:${c.port}`, cleanup });
        },
      );
    },
  );
}

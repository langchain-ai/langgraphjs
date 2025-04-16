import { serve } from "@hono/node-server";
import { Hono } from "hono";

import { registerFromEnv } from "./graph/load.mjs";

import runs from "./api/runs.mjs";
import threads from "./api/threads.mjs";
import assistants from "./api/assistants.mjs";
import store from "./api/store.mjs";
import meta from "./api/meta.mjs";

import { truncate, conn as opsConn } from "./storage/ops.mjs";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { queue } from "./queue.mjs";
import { logger, requestLogger } from "./logging.mjs";
import { checkpointer } from "./storage/checkpoint.mjs";
import { store as graphStore } from "./storage/store.mjs";
import { auth } from "./auth/custom.mjs";
import { registerAuth } from "./auth/index.mjs";
import { registerHttp } from "./http/custom.mjs";
import { cors, ensureContentType } from "./http/middleware.mjs";
import { bindLoopbackFetch } from "./loopback.mjs";

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
  http: z
    .object({
      app: z.string().optional(),
      disable_assistants: z.boolean().default(false),
      disable_threads: z.boolean().default(false),
      disable_runs: z.boolean().default(false),
      disable_store: z.boolean().default(false),
      disable_meta: z.boolean().default(false),
      cors: z
        .object({
          allow_origins: z.array(z.string()).optional(),
          allow_methods: z.array(z.string()).optional(),
          allow_headers: z.array(z.string()).optional(),
          allow_credentials: z.boolean().optional(),
          allow_origin_regex: z.string().optional(),
          expose_headers: z.array(z.string()).optional(),
          max_age: z.number().optional(),
        })
        .optional(),
    })
    .optional(),
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

  const app = new Hono();

  // Loopback fetch used by webhooks and custom routes
  bindLoopbackFetch(app);

  if (options.auth?.path) {
    logger.info(`Loading auth from ${options.auth.path}`);
    await registerAuth(options.auth, { cwd: options.cwd });
    app.use(auth());
  }

  if (options.http?.app) {
    logger.info(`Loading HTTP app from ${options.http.app}`);
    const { api } = await registerHttp(options.http.app, { cwd: options.cwd });
    app.route("/", api);
  }

  app.use(cors(options.http?.cors));
  app.use(requestLogger());
  app.use(ensureContentType());

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

  if (!options.http?.disable_meta) app.route("/", meta);
  if (!options.http?.disable_assistants) app.route("/", assistants);
  if (!options.http?.disable_runs) app.route("/", runs);
  if (!options.http?.disable_threads) app.route("/", threads);
  if (!options.http?.disable_store) app.route("/", store);

  if (options.ui) {
    logger.info(`Registering UI from ${options.cwd}`);
    const { api, registerGraphUi } = await import("./ui/load.mjs");
    await registerGraphUi(options.ui, {
      cwd: options.cwd,
      config: options.ui_config,
    });
    app.route("/", api);
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

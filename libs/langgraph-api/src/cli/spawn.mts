import { spawn } from "node:child_process";

import { StartServerSchema, type StartServerOptions } from "../server.mjs";
import { buildSpawnArgs, resolveNodeLoader } from "./spawn-args.mjs";

export async function spawnServer(
  args: {
    host: string;
    port: string;
    nJobsPerWorker: string;
    reload?: boolean;
  },
  context: {
    config: {
      graphs: Record<string, string | { path: string; description?: string }>;
      ui?: Record<string, string>;
      ui_config?: { shared?: string[] };
      auth?: { path?: string; disable_studio_auth?: boolean };
      node_loader?: string;
      http?: StartServerOptions["http"];
    };
    env: NodeJS.ProcessEnv;
    hostUrl: string;
  },
  options: {
    pid: number;
    projectCwd: string;
  }
) {
  const localUrl = `http://${args.host}:${args.port}`;
  const studioUrl = `${context.hostUrl}/studio?baseUrl=${localUrl}`;

  console.log(`
          Welcome to

╦  ┌─┐┌┐┌┌─┐╔═╗┬─┐┌─┐┌─┐┬ ┬
║  ├─┤││││ ┬║ ╦├┬┘├─┤├─┘├─┤
╩═╝┴ ┴┘└┘└─┘╚═╝┴└─┴ ┴┴  ┴ ┴.js

- 🚀 API: \x1b[36m${localUrl}\x1b[0m
- 🎨 Studio UI: \x1b[36m${studioUrl}\x1b[0m

This in-memory server is designed for development and testing.
For production use, please use LangSmith Deployment.

`);

  const nodeLoader = resolveNodeLoader(context.config.node_loader, context.env);
  const payload: StartServerOptions = StartServerSchema.parse({
    port: Number.parseInt(args.port, 10),
    nWorkers: Number.parseInt(args.nJobsPerWorker, 10),
    host: args.host,
    graphs: context.config.graphs,
    auth: context.config.auth,
    ui: context.config.ui,
    ui_config: context.config.ui_config,
    cwd: options.projectCwd,
    http: context.config.http,
  });
  const { command, args: spawnArgs } = buildSpawnArgs({
    nodeLoader,
    reload: args.reload ?? true,
    pid: options.pid,
    payload,
    resolve: (specifier) => import.meta.resolve(specifier),
  });

  return spawn(command, spawnArgs, {
    stdio: ["inherit", "inherit", "inherit", "ipc"],
    env: {
      ...context.env,
      NODE_ENV: "development",
      LANGGRAPH_API_URL: localUrl,
    },
  });
}

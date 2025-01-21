import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { type Config } from "../utils/config.mjs";

export async function spawnNodeServer(
  args: {
    host: string;
    port: string;
    nJobsPerWorker: string;
    browser: boolean;
    rest: string[];
  },
  context: {
    configPath: string;
    config: Config;
    env: NodeJS.ProcessEnv;
  },
  options: {
    pid: number;
    projectCwd: string;
  }
) {
  const localUrl = `http://${args.host}:${args.port}`;
  const studioUrl = `https://smith.langchain.com/studio?baseUrl=${localUrl}`;

  console.log(`
          Welcome to

╦  ┌─┐┌┐┌┌─┐╔═╗┬─┐┌─┐┌─┐┬ ┬
║  ├─┤││││ ┬║ ╦├┬┘├─┤├─┘├─┤
╩═╝┴ ┴┘└┘└─┘╚═╝┴└─┴ ┴┴  ┴ ┴.js

- 🚀 API: \x1b[36m${localUrl}\x1b[0m
- 🎨 Studio UI: \x1b[36m${studioUrl}\x1b[0m

This in-memory server is designed for development and testing.
For production use, please use LangGraph Cloud.

`);

  return spawn(
    process.execPath,
    [
      fileURLToPath(
        new URL("../../cli.mjs", import.meta.resolve("tsx/esm/api"))
      ),
      "watch",
      "--clear-screen=false",
      fileURLToPath(new URL(import.meta.resolve("./dev.node.entrypoint.mjs"))),
      options.pid.toString(),
      JSON.stringify({
        port: Number.parseInt(args.port, 10),
        nWorkers: Number.parseInt(args.nJobsPerWorker, 10),
        host: args.host,
        graphs: context.config.graphs,
        cwd: options.projectCwd,
      }),
    ],
    { stdio: ["inherit", "inherit", "inherit", "ipc"], env: context.env }
  );
}

/**
 * Dev server lifecycle helper — spawns `langgraph dev` and waits for readiness.
 *
 * Usage:
 *   const { url, stop } = await startDevServer();
 *   // ... use the server ...
 *   stop();
 */

import { spawn, type ChildProcess } from "node:child_process";

const READY_PATTERN = /Server running at ::/;
const DEFAULT_PORT = 2024;
const STARTUP_TIMEOUT_MS = 30_000;

export interface StartDevServerOptions {
  /** Port for the dev server (default: 2024). */
  port?: number;
  /** When true, suppress child process stdout/stderr output. Defaults to false. */
  silent?: boolean;
}

/**
 * Starts a LangGraph dev server in a child process rooted at the
 * `examples/streaming` package so `langgraph.json` is picked up.
 *
 * @param options - Optional port / silent configuration.
 * @returns An object with the server URL and a `stop()` function.
 */
export async function startDevServer(
  options: StartDevServerOptions = {}
): Promise<{ url: string; stop: () => void }> {
  const { port = DEFAULT_PORT, silent = false } = options;
  // Resolve to the streaming package root (two levels up from src/shared/).
  const cwd = new URL("../..", import.meta.url).pathname;
  const proc: ChildProcess = spawn(
    "./node_modules/.bin/langgraphjs",
    ["dev", "--port", String(port), "--no-browser"],
    {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    }
  );

  const url = `http://localhost:${port}`;

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error(`Dev server did not start within ${STARTUP_TIMEOUT_MS}ms`));
    }, STARTUP_TIMEOUT_MS);

    const onData = (chunk: Buffer) => {
      const text = chunk.toString();
      if (!silent) process.stderr.write(text);
      if (READY_PATTERN.test(text)) {
        clearTimeout(timeout);
        resolve();
      }
    };

    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);

    proc.on("error", (err: Error) => {
      clearTimeout(timeout);
      reject(err);
    });

    proc.on("exit", (code: number | null) => {
      clearTimeout(timeout);
      if (code !== 0 && code !== null) {
        reject(new Error(`Dev server exited with code ${code}`));
      }
    });
  });

  return {
    url,
    stop: () => {
      proc.kill("SIGTERM");
    },
  };
}

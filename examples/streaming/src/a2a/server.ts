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

/**
 * Starts a LangGraph dev server in a child process.
 *
 * @param port - Port for the dev server (default: 2024).
 * @returns An object with the server URL and a `stop()` function.
 */
export async function startDevServer(
  port = DEFAULT_PORT
): Promise<{ url: string; stop: () => void }> {
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
      process.stderr.write(text);
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

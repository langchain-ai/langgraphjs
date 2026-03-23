import { Hono } from "hono";
import * as path from "node:path";
import * as url from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import * as net from "node:net";
import { logger } from "../logging.mjs";

const PYTHON_EXTENSIONS = [".py", ".pyx", ".pyd", ".pyi"];

function isPythonFile(filePath: string): boolean {
  return PYTHON_EXTENSIONS.includes(path.extname(filePath));
}

function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        const { port } = addr;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error("Failed to get port")));
      }
    });
    server.on("error", reject);
  });
}

async function waitForPort(
  port: number,
  options?: { timeout?: number }
): Promise<void> {
  const timeout = options?.timeout ?? 30_000;
  const start = Date.now();

  while (Date.now() - start < timeout) {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = net.createConnection({ port, host: "127.0.0.1" }, () => {
          socket.destroy();
          resolve();
        });
        socket.on("error", reject);
      });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(`Timed out waiting for port ${port} after ${timeout}ms`);
}

function createProxyApp(port: number): Hono {
  const target = `http://127.0.0.1:${port}`;
  const app = new Hono();

  app.all("*", async (c) => {
    const reqUrl = new URL(c.req.url);
    const proxyUrl = `${target}${reqUrl.pathname}${reqUrl.search}`;

    const headers = new Headers(c.req.raw.headers);
    headers.delete("host");

    const response = await fetch(proxyUrl, {
      method: c.req.method,
      headers,
      body: c.req.raw.body,
      // @ts-expect-error duplex is required for streaming request bodies
      duplex: "half",
    });

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  });

  return app;
}

async function spawnPythonApp(
  appPath: string,
  options: { cwd: string }
): Promise<{ api: Hono; cleanup: () => Promise<void> }> {
  const [userFile, exportSymbol] = appPath.split(":", 2);
  const sourceFile = path.resolve(options.cwd, userFile);
  const port = await getAvailablePort();

  const modulePath = path
    .relative(options.cwd, sourceFile)
    .replace(/\.[^.]+$/, "")
    .replace(/[/\\]/g, ".");
  const appRef = `${modulePath}:${exportSymbol || "app"}`;

  let pythonCmd: string;
  let pythonArgs: string[];

  try {
    const { execFileSync } = await import("node:child_process");
    execFileSync("uvicorn", ["--version"], { stdio: "ignore" });
    pythonCmd = "uvicorn";
    pythonArgs = [appRef, "--host", "127.0.0.1", "--port", String(port)];
  } catch {
    pythonCmd = "python3";
    pythonArgs = [
      "-m",
      "uvicorn",
      appRef,
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
    ];
  }

  logger.info(`Spawning Python app "${appRef}" on port ${port}`);

  const child: ChildProcess = spawn(pythonCmd, pythonArgs, {
    cwd: options.cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout?.on("data", (data: Buffer) => {
    logger.info(`[python:${appRef}] ${data.toString().trimEnd()}`);
  });

  child.stderr?.on("data", (data: Buffer) => {
    logger.warn(`[python:${appRef}] ${data.toString().trimEnd()}`);
  });

  child.on("error", (err) => {
    logger.error(`Failed to spawn Python app "${appRef}": ${err.message}`);
  });

  const exitPromise = new Promise<void>((_, reject) => {
    child.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        reject(new Error(`Python app "${appRef}" exited with code ${code}`));
      }
    });
  });

  try {
    await Promise.race([waitForPort(port), exitPromise]);
  } catch (err) {
    child.kill();
    throw new Error(
      `Failed to start Python app "${appRef}": ${
        err instanceof Error ? err.message : err
      }`
    );
  }

  const api = createProxyApp(port);

  const cleanup = async () => {
    if (!child.killed) {
      logger.info(`Stopping Python app "${appRef}" (pid ${child.pid})`);
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (!child.killed) child.kill("SIGKILL");
          resolve();
        }, 5_000);
        child.on("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  };

  return { api, cleanup };
}

async function loadApp(
  appPath: string,
  options: { cwd: string }
): Promise<Hono> {
  const [userFile, exportSymbol] = appPath.split(":", 2);

  let module: Record<string, unknown>;
  if (userFile.startsWith(".") || path.isAbsolute(userFile)) {
    const sourceFile = path.resolve(options.cwd, userFile);
    module = await import(url.pathToFileURL(sourceFile).toString());
  } else {
    module = await import(userFile);
  }

  const user = module[exportSymbol || "default"] as Hono | undefined;
  if (!user) throw new Error(`Failed to load HTTP app: ${appPath}`);
  return user;
}

export interface AppRegistration {
  prefix: string;
  api: Hono;
  cleanup?: () => Promise<void>;
}

export async function registerHttp(
  appPath: string,
  options: { cwd: string }
): Promise<AppRegistration> {
  const [userFile] = appPath.split(":", 2);

  if (isPythonFile(userFile)) {
    const { api, cleanup } = await spawnPythonApp(appPath, options);
    return { prefix: "/", api, cleanup };
  }

  const api = await loadApp(appPath, options);
  return { prefix: "/", api };
}

export async function registerHttpApps(
  apps: Record<string, string>,
  options: { cwd: string }
): Promise<AppRegistration[]> {
  const results: AppRegistration[] = [];

  for (const [prefix, appPath] of Object.entries(apps)) {
    const normalizedPrefix = prefix.startsWith("/") ? prefix : `/${prefix}`;
    const [userFile] = appPath.split(":", 2);

    if (isPythonFile(userFile)) {
      const { api, cleanup } = await spawnPythonApp(appPath, options);
      results.push({ prefix: normalizedPrefix, api, cleanup });
    } else {
      const api = await loadApp(appPath, options);
      results.push({ prefix: normalizedPrefix, api });
    }
  }

  return results;
}

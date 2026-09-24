import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createIpcServer } from "../../langgraph-cli/src/cli/utils/ipc/server.mjs";
import {
  buildSpawnArgs,
  DEFAULT_NODE_LOADER,
  LOADER_REGISTRATIONS,
  resolveLoaderPath,
  resolveLoaderRegistration,
  resolveNodeLoader,
  toNodeModuleUrl,
  usesTsxCli,
} from "../src/cli/spawn-args.mjs";
import type { StartServerOptions } from "../src/server.mjs";

const payload: StartServerOptions = {
  port: 2024,
  nWorkers: 10,
  host: "localhost",
  graphs: { agent: "./agent.ts:graph" },
  cwd: "/tmp/project",
};

const mockResolve =
  (map: Record<string, string>) =>
  (specifier: string): string => {
    const resolved = map[specifier];
    if (!resolved) throw new Error(`Cannot resolve ${specifier}`);
    return resolved;
  };

describe("resolveNodeLoader", () => {
  it("defaults to tsx", () => {
    expect(resolveNodeLoader(undefined)).toBe(DEFAULT_NODE_LOADER);
    expect(resolveNodeLoader("ts-node/esm")).toBe("ts-node/esm");
  });

  it("prefers LANGGRAPH_NODE_LOADER env override", () => {
    expect(
      resolveNodeLoader("tsx", {
        ...process.env,
        LANGGRAPH_NODE_LOADER: "tsx/esm",
      })
    ).toBe("tsx/esm");
  });
});

describe("usesTsxCli", () => {
  it("only treats the default tsx shorthand as CLI mode", () => {
    expect(usesTsxCli("tsx")).toBe(true);
    expect(usesTsxCli("tsx/esm")).toBe(false);
    expect(usesTsxCli("ts-node")).toBe(false);
  });
});

describe("LOADER_REGISTRATIONS", () => {
  it("registers ts-node shorthands with --loader", () => {
    expect(LOADER_REGISTRATIONS["ts-node"]).toEqual({
      specifier: "ts-node/esm",
      flag: "--loader",
    });
    expect(LOADER_REGISTRATIONS["ts-node/esm"]).toEqual({
      specifier: "ts-node/esm",
      flag: "--loader",
    });
  });
});

describe("resolveLoaderRegistration", () => {
  it("maps ts-node shorthand to ts-node/esm via --loader", () => {
    const resolved = resolveLoaderRegistration("ts-node", (specifier) =>
      import.meta.resolve(specifier)
    );
    expect(resolved.flag).toBe("--loader");
    expect(resolved.specifier).toBe("ts-node/esm");
    expect(resolved.path).toContain(`${sep}ts-node${sep}`);
    expect(resolved.path.endsWith(`${sep}esm.mjs`)).toBe(true);
  });

  it("maps ts-node/esm explicitly via --loader", () => {
    const resolved = resolveLoaderRegistration("ts-node/esm", (specifier) =>
      import.meta.resolve(specifier)
    );
    expect(resolved).toMatchObject({
      flag: "--loader",
      specifier: "ts-node/esm",
    });
  });

  it("defaults unknown loaders to --import", () => {
    const loaderPath = join(tmpdir(), "tsx", "esm.mjs");
    const resolved = resolveLoaderRegistration(
      "tsx/esm",
      mockResolve({
        "tsx/esm": pathToFileURL(loaderPath).href,
      })
    );
    expect(resolved).toMatchObject({
      flag: "--import",
      specifier: "tsx/esm",
      path: loaderPath,
    });
  });
});

describe("resolveLoaderPath", () => {
  it("resolves absolute paths unchanged", () => {
    const loaderPath = join(tmpdir(), "custom-loader.mjs");
    expect(
      resolveLoaderPath(loaderPath, loaderPath, () => {
        throw new Error("should not resolve");
      })
    ).toBe(loaderPath);
  });

  it("resolves file URLs unchanged", () => {
    const loaderPath = join(tmpdir(), "custom-loader.mjs");
    const loaderUrl = pathToFileURL(loaderPath).href;
    expect(
      resolveLoaderPath(loaderUrl, loaderUrl, () => {
        throw new Error("should not resolve");
      })
    ).toBe(fileURLToPath(loaderUrl));
  });

  it("includes ts-node setup hint when resolution fails", () => {
    expect(() =>
      resolveLoaderPath("ts-node/esm", "ts-node", () => {
        throw new Error("missing");
      })
    ).toThrow(/emitDecoratorMetadata/);
  });

  it("omits ts-node hint for unrelated loaders", () => {
    expect(() =>
      resolveLoaderPath("missing/pkg", "missing/pkg", () => {
        throw new Error("missing");
      })
    ).toThrow(/could not be resolved/);

    expect(() =>
      resolveLoaderPath("missing/pkg", "missing/pkg", () => {
        throw new Error("missing");
      })
    ).not.toThrow(/emitDecoratorMetadata/);
  });
});

describe("buildSpawnArgs", () => {
  const resolveFromSpawn = (specifier: string) =>
    import.meta.resolve(specifier, import.meta.resolve("../src/cli/spawn.mjs"));

  it("builds tsx watch args by default", () => {
    const { command, args } = buildSpawnArgs({
      nodeLoader: "tsx",
      reload: true,
      pid: 42,
      payload,
      resolve: resolveFromSpawn,
    });

    expect(command).toBe(process.execPath);
    expect(args).toContain("watch");
    expect(args).toContain("--clear-screen=false");
    expect(args.at(-2)).toBe("42");
    expect(JSON.parse(args.at(-1)!)).toEqual(payload);
  });

  it("omits tsx watch when reload is disabled", () => {
    const { args } = buildSpawnArgs({
      nodeLoader: "tsx",
      reload: false,
      pid: 42,
      payload,
      resolve: resolveFromSpawn,
    });

    expect(args).not.toContain("watch");
    expect(args).not.toContain("--clear-screen=false");
  });

  it("runs typed code without reload and keeps loader traffic off Studio IPC", async () => {
    const dir = await mkdtemp(join(tmpdir(), "langgraph-no-reload-"));
    const [pid, server] = await createIpcServer();
    const messages: unknown[] = [];
    const sockets = new Set<Socket>();
    server.on("connection", (socket: Socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    const received = new Promise<void>((resolve) => {
      server.on("data", (message: unknown) => {
        messages.push(message);
        if (
          typeof message === "object" &&
          message !== null &&
          "queryParams" in message &&
          message.queryParams === "graph=agent"
        )
          resolve();
      });
    });
    try {
      const preload = join(dir, "preload.mjs");
      const entrypoint = join(dir, "entrypoint.mts");
      const client = new URL(
        "../src/cli/utils/ipc/client.mts",
        import.meta.url
      );
      await writeFile(preload, "process.env.SPAWN_TEST_PRELOADED = '1';");
      await writeFile(
        entrypoint,
        `
        import { connectToServer } from ${JSON.stringify(client.href)};
        const acknowledged = new Promise<void>((resolve) => {
          process.stdin.once("end", resolve);
          process.stdin.resume();
        });
        const value: number = 42;
        const send = await connectToServer(Number(process.argv.at(-2)));
        if (!send) throw new Error("Studio IPC connection failed");
        send({ queryParams: "graph=agent" });
        console.log(JSON.stringify({ value, preloaded: process.env.SPAWN_TEST_PRELOADED,
          payload: JSON.parse(process.argv.at(-1)) }));
        await acknowledged;
      `
      );
      const invocation = buildSpawnArgs({
        nodeLoader: "tsx",
        reload: false,
        pid,
        payload,
        resolve: (specifier) => {
          if (specifier === "../preload.mjs")
            return pathToFileURL(preload).href;
          if (specifier === "./entrypoint.mjs")
            return pathToFileURL(entrypoint).href;
          return import.meta.resolve(specifier);
        },
      });
      const execution = promisify(execFile)(
        invocation.command,
        invocation.args,
        { timeout: 10_000, env: { ...process.env, NODE_OPTIONS: "" } }
      );
      try {
        await Promise.race([
          received,
          execution.then(() => {
            throw new Error("Child exited before Studio IPC was received");
          }),
        ]);
        execution.child.stdin?.end();
        const { stdout } = await execution;
        expect(JSON.parse(stdout)).toEqual({
          value: 42,
          preloaded: "1",
          payload,
        });
        expect(messages).toEqual([{ queryParams: "graph=agent" }]);
      } finally {
        execution.child.stdin?.end();
        if (
          execution.child.exitCode === null &&
          execution.child.signalCode === null
        ) {
          execution.child.kill();
        }
        await execution.catch(() => undefined);
      }
    } finally {
      for (const socket of sockets) socket.destroy();
      try {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error("IPC server did not close")),
            1_000
          );
          server.close((err) => {
            clearTimeout(timeout);
            if (err) reject(err);
            else resolve();
          });
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  it("registers ts-node with node --loader before preload --import", () => {
    const { command, args } = buildSpawnArgs({
      nodeLoader: "ts-node",
      reload: true,
      pid: 99,
      payload,
      resolve: resolveFromSpawn,
    });

    expect(command).toBe(process.execPath);
    expect(args.slice(0, 5)).toEqual([
      "--watch",
      "--loader",
      expect.stringMatching(/^file:\/\//),
      "--import",
      expect.stringMatching(/^file:\/\/.*preload\.mjs$/),
    ]);
    expect(args[1]).toBe("--loader");
    expect(args[2]).not.toBe("--import");
    expect(args.at(-2)).toBe("99");
    expect(JSON.parse(args.at(-1)!)).toEqual(payload);
  });

  it("registers ts-node/esm the same way as ts-node", () => {
    const tsNode = buildSpawnArgs({
      nodeLoader: "ts-node",
      reload: false,
      pid: 1,
      payload,
      resolve: resolveFromSpawn,
    }).args.slice(0, 3);

    const tsNodeEsm = buildSpawnArgs({
      nodeLoader: "ts-node/esm",
      reload: false,
      pid: 1,
      payload,
      resolve: resolveFromSpawn,
    }).args.slice(0, 3);

    expect(tsNodeEsm).toEqual(tsNode);
    expect(tsNodeEsm[0]).toBe("--loader");
  });

  it("omits node --watch for ts-node when reload is disabled", () => {
    const { args } = buildSpawnArgs({
      nodeLoader: "ts-node",
      reload: false,
      pid: 1,
      payload,
      resolve: resolveFromSpawn,
    });

    expect(args[0]).toBe("--loader");
    expect(args).not.toContain("--watch");
  });

  it("supports arbitrary import loaders like tsx/esm", () => {
    const { command, args } = buildSpawnArgs({
      nodeLoader: "tsx/esm",
      reload: false,
      pid: 1,
      payload,
      resolve: (specifier) => import.meta.resolve(specifier),
    });

    expect(command).toBe(process.execPath);
    expect(args).not.toContain("watch");
    expect(args).not.toContain("--loader");
    expect(args[0]).toBe("--import");
    expect(args[1]).toMatch(/^file:\/\//);
    expect(args[1]).toContain("tsx");
  });

  it("places entrypoint and IPC payload after preload import", () => {
    const { args } = buildSpawnArgs({
      nodeLoader: "ts-node",
      reload: false,
      pid: 7,
      payload,
      resolve: resolveFromSpawn,
    });

    const preloadIndex = args.indexOf("--import");
    expect(preloadIndex).toBeGreaterThan(args.indexOf("--loader"));
    expect(args[preloadIndex + 1]).toMatch(/^file:\/\/.*preload\.mjs$/);
    expect(args[preloadIndex + 2]).toContain("entrypoint.mjs");
    expect(args.at(-2)).toBe("7");
    expect(JSON.parse(args.at(-1)!)).toEqual(payload);
  });
});

describe("toNodeModuleUrl", () => {
  it("converts absolute paths to file URLs", () => {
    const loaderPath = join(tmpdir(), "custom-loader.mjs");
    expect(toNodeModuleUrl(loaderPath)).toBe(pathToFileURL(loaderPath).href);
  });

  it("passes through existing file URLs", () => {
    const loaderUrl = pathToFileURL(join(tmpdir(), "custom-loader.mjs")).href;
    expect(toNodeModuleUrl(loaderUrl)).toBe(loaderUrl);
  });
});

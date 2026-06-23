import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
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

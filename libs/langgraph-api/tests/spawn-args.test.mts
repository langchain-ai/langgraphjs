import { sep } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildSpawnArgs,
  DEFAULT_NODE_LOADER,
  resolveLoaderImport,
  resolveNodeLoader,
  type SpawnServerPayload,
  usesTsxCli,
} from "../src/cli/spawn-args.mjs";

const payload: SpawnServerPayload = {
  port: 2024,
  nWorkers: 10,
  host: "localhost",
  graphs: { agent: "./agent.ts:graph" },
  cwd: "/tmp/project",
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

describe("resolveLoaderImport", () => {
  it("maps ts-node shorthand to ts-node/esm", () => {
    const resolved = resolveLoaderImport("ts-node", (specifier) =>
      import.meta.resolve(specifier)
    );
    expect(resolved).toContain(`${sep}ts-node${sep}`);
    expect(resolved.endsWith(`${sep}esm.mjs`)).toBe(true);
  });
});

describe("buildSpawnArgs", () => {
  it("builds tsx watch args by default", () => {
    const { command, args } = buildSpawnArgs({
      nodeLoader: "tsx",
      reload: true,
      pid: 42,
      payload,
      resolve: (specifier) => import.meta.resolve(specifier),
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
      resolve: (specifier) => import.meta.resolve(specifier),
    });

    expect(args).not.toContain("watch");
  });

  it("builds node import loader args with node --watch", () => {
    const { command, args } = buildSpawnArgs({
      nodeLoader: "ts-node",
      reload: true,
      pid: 99,
      payload,
      resolve: (specifier) => import.meta.resolve(specifier),
    });

    expect(command).toBe(process.execPath);
    expect(args[0]).toBe("--watch");
    expect(args).toContain("--import");
    expect(args.at(-2)).toBe("99");
    expect(JSON.parse(args.at(-1)!)).toEqual(payload);
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
    expect(args[0]).toBe("--import");
    expect(args[1]).toContain("tsx");
  });
});

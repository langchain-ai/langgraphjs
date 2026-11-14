import { afterEach, beforeEach, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const { gracefulExit } = vi.hoisted(() => ({ gracefulExit: vi.fn() }));

vi.mock("exit-hook", () => ({ gracefulExit }));
vi.mock("execa", () => ({ $: () => async () => ({ exitCode: 0 }) }));
vi.mock("../src/cli/utils/analytics.mjs", () => ({
  withAnalytics: () => () => {},
}));
vi.mock("../src/cli/utils/archive.mjs", () => ({
  BYTES_PER_MIB: 1024 * 1024,
  MAX_SIZE: 200 * 1024 * 1024,
  createArchive: async (configPath: string) => ({
    archivePath: configPath,
    fileSize: 0,
    configRel: "langgraph.json",
    cleanup: async () => {},
  }),
}));

export { gracefulExit };

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

export interface DeployHarness {
  /** The project's `langgraph.json`, in a fresh directory per test. */
  configPath: string;
  /** Everything the CLI wrote to stdout and stderr in the current test. */
  output: string;
}

/**
 * Run each test with fresh CLI modules, a temporary `langgraph.json` holding
 * `config`, and captured output.
 */
export function useDeployHarness(
  config: Record<string, unknown> = {}
): DeployHarness {
  const harness: DeployHarness = { configPath: "", output: "" };
  const capture = (chunk: unknown) => {
    harness.output += String(chunk);
    return true;
  };

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    harness.output = "";
    vi.spyOn(process.stdout, "write").mockImplementation(capture);
    vi.spyOn(process.stderr, "write").mockImplementation(capture);
    const projectDir = await mkdtemp(path.join(os.tmpdir(), "deploy-test-"));
    await writeFile(path.join(projectDir, "agent.ts"), "");
    harness.configPath = path.join(projectDir, "langgraph.json");
    await writeFile(
      harness.configPath,
      JSON.stringify({
        node_version: "20",
        graphs: { agent: "./agent.ts:graph" },
        image_distro: "wolfi",
        ...config,
      })
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await rm(path.dirname(harness.configPath), {
      recursive: true,
      force: true,
    });
  });

  return harness;
}

/** Run `langgraphjs deploy <args>` with a test API key. */
export async function runDeployCli(...args: string[]): Promise<void> {
  await import("../src/cli/deploy.mjs");
  const { builder } = await import("../src/cli/utils/builder.mjs");
  await builder.parseAsync(["deploy", ...args, "--api-key", "test-key"], {
    from: "user",
  });
}

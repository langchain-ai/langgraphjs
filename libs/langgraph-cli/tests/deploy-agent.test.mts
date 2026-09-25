import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gracefulExit } from "exit-hook";

vi.mock("exit-hook", () => ({ gracefulExit: vi.fn() }));
vi.mock("execa", () => ({ $: () => async () => ({ exitCode: 0 }) }));
vi.mock("../src/cli/utils/analytics.mjs", () => ({
  withAnalytics: () => () => {},
}));
vi.mock("../src/cli/utils/archive.mjs", () => ({
  BYTES_PER_MIB: 1024 * 1024,
  createArchive: async (configPath: string) => ({
    archivePath: configPath,
    fileSize: 0,
    configRel: "langgraph.json",
    cleanup: async () => {},
  }),
}));

const fetchMock = vi.fn();
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
let configPath: string;
let output: string;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv("LANGSMITH_AGENT_ID", "my-agent");
  vi.stubEnv("LANGSMITH_AGENT_ENVIRONMENT", "staging");
  vi.stubEnv("LANGSMITH_DEPLOYMENT_NAME", "ignore-me");
  vi.stubGlobal("fetch", fetchMock);
  output = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
  configPath = path.join(
    await mkdtemp(path.join(os.tmpdir(), "deploy-agent-")),
    "langgraph.json"
  );
  await writeFile(
    configPath,
    JSON.stringify({
      node_version: "20",
      graphs: { agent: "./agent.ts:graph" },
      image_distro: "wolfi",
      env: { LANGSMITH_DEPLOYMENT_NAME: "also-ignore-me" },
    })
  );
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(path.dirname(configPath), { recursive: true, force: true });
});

async function run(...args: string[]) {
  await import("../src/cli/deploy.mjs");
  const { builder } = await import("../src/cli/utils/builder.mjs");
  await builder.parseAsync(["deploy", ...args, "--api-key", "test-key"], {
    from: "user",
  });
}

it.each([false, true])("deploys by agent (existing: %s)", async (existing) => {
  fetchMock.mockResolvedValueOnce(
    json({
      resources: existing
        ? [{ id: "preview", is_preview: true }, { id: "dep-1" }]
        : [],
    })
  );
  if (!existing)
    fetchMock.mockResolvedValueOnce(
      json({ id: "dep-1", name: "generated-name" })
    );
  fetchMock.mockResolvedValueOnce(
    json({ upload_url: "https://upload.example/source", object_path: "source" })
  );
  fetchMock.mockImplementationOnce(async (_url, init) => {
    await new Response(init.body).arrayBuffer();
    return json({});
  });
  fetchMock.mockResolvedValueOnce(json({ id: "dep-1" }));

  await run(
    "--config",
    configPath,
    "--remote",
    "--no-wait",
    "--no-input",
    "--json"
  );

  const [url] = fetchMock.mock.calls[0];
  expect(new URL(url).searchParams.get("agent_id")).toBe("my-agent");
  expect(new URL(url).searchParams.get("agent_environment")).toBe("staging");
  expect(new URL(url).searchParams.get("name_contains")).toBe("");
  if (!existing) {
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      agent: { agent_id: "my-agent", environment: "staging" },
      source: "internal_source",
      source_config: { deployment_type: "dev" },
      source_revision_config: {},
      secrets: [],
    });
  }
  const [updateUrl, update] = fetchMock.mock.calls.at(-1)!;
  expect(new URL(updateUrl).pathname).toBe("/v2/deployments/dep-1");
  expect(update.method).toBe("PATCH");
  expect(JSON.parse(update.body).revision_source).toBe("internal_source");
  expect(fetchMock).toHaveBeenCalledTimes(existing ? 4 : 5);
  expect(gracefulExit).not.toHaveBeenCalled();
  expect(
    output
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).message)
  ).toContain(
    "Note: --agent-id and --agent-environment flags are in private beta"
  );
});

it("lets list flags override environment defaults", async () => {
  vi.stubEnv("LANGSMITH_AGENT_ENVIRONMENT", "invalid");
  fetchMock.mockResolvedValueOnce(json({ resources: [] }));
  await run(
    "list",
    "--agent-id",
    "other-agent",
    "--agent-environment",
    "production"
  );
  const params = new URL(fetchMock.mock.calls[0][0]).searchParams;
  expect(params.get("agent_id")).toBe("other-agent");
  expect(params.get("agent_environment")).toBe("production");
  expect(gracefulExit).not.toHaveBeenCalled();
});

it("stops when the tenant cannot use agent filters", async () => {
  fetchMock.mockResolvedValueOnce(
    json({ detail: "Agent filters are not available for this tenant." }, 400)
  );
  await run("--config", configPath, "--remote", "--no-input", "--json");
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(gracefulExit).toHaveBeenCalledWith(1);
  expect(output).toContain("Agent filters are not available for this tenant.");
});

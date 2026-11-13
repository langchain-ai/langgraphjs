import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  MAX_SIZE: 200 * 1024 * 1024,
  createArchive: async (configPath: string) => ({
    archivePath: configPath,
    fileSize: 0,
    configRel: "langgraph.json",
    cleanup: async () => {},
  }),
}));

const DATA_PLANE_URL = "https://langsmith.customer.example";
const CLOUD_HOST_URL = "https://api.host.langchain.com";
const BYOC_WORKSPACE = { id: "ws-1", data_plane_url: DATA_PLANE_URL };
const SAAS_WORKSPACE = { id: "ws-2", data_plane_url: null };
const ALL_FLAGS = {
  deployments_cli_builds_supported: true,
  deployments_dedicated_supported: true,
};
const DISCOVER = "GET https://api.smith.langchain.com/api/v1/tenants";
const INFO = `GET ${DATA_PLANE_URL}/api/v1/info`;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

interface Call {
  route: string;
  headers: Record<string, string>;
  body: unknown;
}

let calls: Call[];
let routes: Record<string, () => Response>;
let configPath: string;
let output: string;

function serve(overrides: Record<string, () => Response> = {}): void {
  routes = {
    [DISCOVER]: () => json([]),
    [INFO]: () => json({ instance_flags: ALL_FLAGS }),
    "GET /v2/deployments": () => json({ resources: [] }),
    "POST /v2/deployments": () => json({ id: "dep-1" }),
    "POST /v2/deployments/dep-1/upload-url": () =>
      json({ upload_url: "https://upload.example/source", object_path: "src" }),
    "PUT https://upload.example/source": () => json({}),
    "PATCH /v2/deployments/dep-1": () => json({ tenant_id: "tenant-1" }),
    "GET /v2/deployments/dep-1/revisions": () =>
      json({ resources: [{ id: "rev-1" }] }),
    "POST /v1/projects/dep-1/revisions/rev-1/build_logs": () =>
      json({ logs: [] }),
    ...overrides,
  };
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  for (const name of ["LANGSMITH_TENANT_ID", "LANGSMITH_ENDPOINT"]) {
    vi.stubEnv(name, "");
  }
  calls = [];
  serve();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init: RequestInit) => {
      const url = new URL(input);
      const route = `${init.method} ${url.origin}${url.pathname}`;
      const body =
        typeof init.body === "string" ? JSON.parse(init.body) : undefined;
      if (init.body && typeof init.body !== "string") {
        await new Response(init.body).arrayBuffer();
      }
      calls.push({
        route,
        headers: Object.fromEntries(new Headers(init.headers)),
        body,
      });
      const handler =
        routes[route] ??
        routes[`${init.method} ${url.pathname.replace(/^\/api-host/, "")}`];
      return handler ? handler() : json({ detail: `unexpected ${route}` }, 599);
    })
  );
  output = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
  configPath = path.join(
    await mkdtemp(path.join(os.tmpdir(), "deploy-byoc-")),
    "langgraph.json"
  );
  await writeFile(
    configPath,
    JSON.stringify({
      node_version: "20",
      graphs: { agent: "./agent.ts:graph" },
      image_distro: "wolfi",
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

const remoteDeploy = (...args: string[]) =>
  run(
    "--config",
    configPath,
    "--name",
    "my-app",
    "--remote",
    "--no-wait",
    "--no-input",
    "--json",
    ...args
  );

const createBody = () =>
  calls.find((call) => /^POST \S+\/v2\/deployments$/.test(call.route))
    ?.body as Record<string, unknown>;

describe("on a BYOC data plane", () => {
  beforeEach(() => serve({ [DISCOVER]: () => json([BYOC_WORKSPACE]) }));

  it("deploys through the data plane with the discovered workspace", async () => {
    await remoteDeploy();

    expect(gracefulExit).not.toHaveBeenCalled();
    expect(calls.slice(0, 2).map((call) => call.route)).toEqual([
      DISCOVER,
      INFO,
    ]);
    const hostCalls = calls.filter((call) =>
      call.route.includes(`${DATA_PLANE_URL}/api-host/`)
    );
    expect(hostCalls.length).toBeGreaterThan(0);
    expect(hostCalls.every((call) => call.headers["x-tenant-id"] === "ws-1")).toBe(true);
    expect(createBody().source_config).toEqual({ resource_spec: {} });
    expect(output).toContain(
      "https://smith.langchain.com/o/tenant-1/host/deployments/dep-1"
    );
  });

  it("sizes a prod deployment as dedicated", async () => {
    await remoteDeploy("--deployment-type", "prod");

    expect(createBody().source_config).toEqual({
      resource_spec: null,
      deployment_type: "prod",
    });
  });

  it.each([
    {
      label: "prod without dedicated support",
      flags: { deployments_cli_builds_supported: true },
      args: ["--deployment-type", "prod"],
      expected: "does not support prod (dedicated) deployments",
    },
    {
      label: "no CLI builds",
      flags: { deployments_dedicated_supported: true },
      args: [],
      expected: "--push-to <registry>/<repository>",
    },
  ])("refuses $label before creating anything", async (c) => {
    serve({
      [DISCOVER]: () => json([BYOC_WORKSPACE]),
      [INFO]: () => json({ instance_flags: c.flags }),
    });

    await remoteDeploy(...c.args);

    expect(gracefulExit).toHaveBeenCalledWith(1);
    expect(output).toContain(c.expected);
    expect(createBody()).toBeUndefined();
  });

  it("redeploys an existing prod deployment without dedicated support", async () => {
    serve({
      [DISCOVER]: () => json([BYOC_WORKSPACE]),
      [INFO]: () =>
        json({ instance_flags: { deployments_cli_builds_supported: true } }),
      "GET /v2/deployments/dep-1": () => json({ id: "dep-1" }),
    });

    await remoteDeploy("--deployment-id", "dep-1", "--deployment-type", "prod");

    expect(gracefulExit).not.toHaveBeenCalled();
    expect(createBody()).toBeUndefined();
  });

  it("names both external image flags without CLI builds", async () => {
    serve({
      [DISCOVER]: () => json([BYOC_WORKSPACE]),
      [INFO]: () => json({}),
    });

    await remoteDeploy();

    expect(output).toContain("--push-to");
    expect(output).toContain("--image-uri");
  });

  it("surfaces a data plane's 501 as it is", async () => {
    const hint = "Local image pushes are not supported here; use --remote.";
    serve({
      [DISCOVER]: () => json([BYOC_WORKSPACE]),
      "POST /v2/deployments": () => json({ detail: hint }, 501),
    });

    await remoteDeploy();

    expect(gracefulExit).toHaveBeenCalledWith(1);
    expect(output).toContain(hint);
  });

  it("reads build logs from the data plane with the workspace", async () => {
    await run("logs", "--type", "build", "--deployment-id", "dep-1");

    expect(
      calls
        .filter((call) => call.route !== DISCOVER)
        .map((call) => [call.route, call.headers["x-tenant-id"]])
    ).toEqual([
      [`GET ${DATA_PLANE_URL}/api-host/v2/deployments/dep-1/revisions`, "ws-1"],
      [
        `POST ${DATA_PLANE_URL}/api-host/v1/projects/dep-1/revisions/rev-1/build_logs`,
        "ws-1",
      ],
    ]);
  });

  it("links LangSmith, not the data plane, when deployments are off", async () => {
    serve({
      [DISCOVER]: () => json([BYOC_WORKSPACE]),
      "GET /v2/deployments": () =>
        json({ detail: "LangSmith Deployment is not enabled" }, 403),
    });

    await run("list");

    expect(output).toContain("https://smith.langchain.com/host/deployments");
    expect(output).not.toContain("customer.example");
  });

  it("lets --host-url override discovery", async () => {
    await remoteDeploy("--host-url", "https://host.example.com");

    expect(calls.map((call) => call.route)).not.toContain(DISCOVER);
    expect(createBody().source_config).toEqual({ deployment_type: "dev" });
  });
});

describe("off a data plane", () => {
  it.each([
    {
      label: "a LangSmith cloud workspace",
      discover: () => json([SAAS_WORKSPACE]),
    },
    { label: "a failed lookup", discover: () => json({}, 500) },
    {
      label: "workspaces on different planes and no tenant",
      discover: () => json([BYOC_WORKSPACE, SAAS_WORKSPACE]),
    },
  ])("keeps today's control plane for $label", async (c) => {
    serve({ [DISCOVER]: c.discover });

    await remoteDeploy();

    expect(gracefulExit).not.toHaveBeenCalled();
    expect(calls.map((call) => call.route)).not.toContain(INFO);
    const hostCalls = calls.filter((call) =>
      call.route.includes(`${CLOUD_HOST_URL}/`)
    );
    expect(hostCalls.length).toBeGreaterThan(0);
    expect(hostCalls.every((call) => !call.headers["x-tenant-id"])).toBe(true);
    expect(createBody().source_config).toEqual({ deployment_type: "dev" });
  });

  it("names a LANGSMITH_TENANT_ID the key cannot use", async () => {
    vi.stubEnv("LANGSMITH_TENANT_ID", "unknown-ws");
    serve({ [DISCOVER]: () => json([BYOC_WORKSPACE]) });

    await remoteDeploy();

    expect(gracefulExit).toHaveBeenCalledWith(1);
    expect(output).toContain("unknown-ws");
    expect(calls.map((call) => call.route)).toEqual([DISCOVER]);
  });

  it("hints at external images when an older data plane rejects the source", async () => {
    serve({
      "POST /v2/deployments": () =>
        json({ detail: "'source' must be one of ['github', 'external_docker']" }, 400),
    });

    await remoteDeploy("--host-url", "https://host.example.com");

    expect(gracefulExit).toHaveBeenCalledWith(1);
    expect(output).toContain("'source' must be one of");
    expect(output).toContain("--push-to <registry>/<repository>");
  });
});

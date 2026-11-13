import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  gracefulExit,
  json,
  runDeployCli,
  useDeployHarness,
} from "./deploy-harness.mjs";

const { promptAnswer } = vi.hoisted(() => ({ promptAnswer: vi.fn() }));
vi.mock("node:readline", () => ({
  default: {
    createInterface: () => ({
      question: (_: string, answer: (text: string) => void) =>
        answer(promptAnswer()),
      close: () => {},
    }),
  },
}));

const DATA_PLANE_URL = "https://langsmith.customer.example";
const DATA_PLANE_HOST = `${DATA_PLANE_URL}/api-host`;
const OTHER_DATA_PLANE_URL = "https://langsmith.other.example";
const OTHER_DATA_PLANE_HOST = `${OTHER_DATA_PLANE_URL}/api-host`;
const CLOUD_HOST_URL = "https://api.host.langchain.com";
const WORKSPACE_ID = "0b6e7f3e-2c1d-4a5b-9e8f-1a2b3c4d5e6f";
const BYOC_WORKSPACE = { id: WORKSPACE_ID, data_plane_url: DATA_PLANE_URL };
const OTHER_BYOC_WORKSPACE = {
  id: "ws-other",
  data_plane_url: OTHER_DATA_PLANE_URL,
};
const SAAS_WORKSPACE = { id: "ws-saas", data_plane_url: null };
const ALL_FLAGS = {
  deployments_cli_builds_supported: true,
  deployments_dedicated_supported: true,
};
const DISCOVER = "GET https://api.smith.langchain.com/api/v1/workspaces";
const info = (dataPlaneUrl: string) => `GET ${dataPlaneUrl}/api/v1/info`;
const INFO = info(DATA_PLANE_URL);
const UPLOAD = "PUT https://upload.example/source";

type Routes = Record<string, () => Response>;

interface Call {
  route: string;
  headers: Record<string, string>;
  body: unknown;
}

const harness = useDeployHarness();
let calls: Call[];
let routes: Routes;

/**
 * Answer each request whose `METHOD URL` matches a route exactly. Routes
 * written as `METHOD /path` are host backend routes under `hostUrl`.
 */
function serve(hostUrl: string, overrides: Routes = {}): void {
  const all: Routes = {
    [DISCOVER]: () => json([]),
    [INFO]: () => json({ instance_flags: ALL_FLAGS }),
    [UPLOAD]: () => json({}),
    "GET /v2/deployments": () => json({ resources: [] }),
    "POST /v2/deployments": () => json({ id: "dep-1" }),
    "POST /v2/deployments/dep-1/upload-url": () =>
      json({ upload_url: "https://upload.example/source", object_path: "src" }),
    "POST /v2/deployments/dep-1/push-token": () =>
      json({ token: "push-token", registry_url: "registry.example/project" }),
    "PATCH /v2/deployments/dep-1": () => json({ tenant_id: "tenant-1" }),
    "GET /v2/deployments/dep-1/revisions": () =>
      json({ resources: [{ id: "rev-1" }] }),
    "POST /v1/projects/dep-1/revisions/rev-1/build_logs": () =>
      json({ logs: [] }),
    ...overrides,
  };
  routes = Object.fromEntries(
    Object.entries(all).map(([route, handler]) => {
      const [method, target] = route.split(" ");
      return [
        target.startsWith("/") ? `${method} ${hostUrl}${target}` : route,
        handler,
      ];
    })
  );
}

beforeEach(() => {
  for (const name of ["LANGSMITH_TENANT_ID", "LANGSMITH_ENDPOINT"]) {
    vi.stubEnv(name, "");
  }
  calls = [];
  serve(DATA_PLANE_HOST);
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
      const handler = routes[route];
      return handler ? handler() : json({ detail: `unexpected ${route}` }, 599);
    })
  );
});

const deploy = (...args: string[]) =>
  runDeployCli(
    "--config",
    harness.configPath,
    "--name",
    "my-app",
    "--no-wait",
    "--no-input",
    "--json",
    ...args
  );

const remoteDeploy = (...args: string[]) => deploy("--remote", ...args);

const createBody = () =>
  calls.find((call) => /^POST \S+\/v2\/deployments$/.test(call.route))
    ?.body as Record<string, unknown>;

const isHostCall = (call: Call) =>
  call.route !== UPLOAD && !/\/api\/v1\/(workspaces|info)$/.test(call.route);

/** Every host backend call went to `hostUrl` as `tenantId`. */
function expectHostCalls(hostUrl: string, tenantId?: string): void {
  const hostCalls = calls.filter(isHostCall);
  expect(hostCalls.length).toBeGreaterThan(0);
  expect(
    hostCalls.filter((call) => !call.route.includes(` ${hostUrl}/`))
  ).toEqual([]);
  expect(hostCalls.map((call) => call.headers["x-tenant-id"])).toEqual(
    hostCalls.map(() => tenantId)
  );
}

describe("on a BYOC data plane", () => {
  beforeEach(() =>
    serve(DATA_PLANE_HOST, { [DISCOVER]: () => json([BYOC_WORKSPACE]) })
  );

  it("deploys through the data plane with the discovered workspace", async () => {
    await remoteDeploy();

    expect(gracefulExit).not.toHaveBeenCalled();
    expect(calls.slice(0, 2).map((call) => call.route)).toEqual([
      DISCOVER,
      INFO,
    ]);
    expectHostCalls(DATA_PLANE_HOST, WORKSPACE_ID);
    expect(createBody().source_config).toEqual({ resource_spec: {} });
    expect(harness.output).toContain(
      "https://smith.langchain.com/o/tenant-1/host/deployments/dep-1"
    );
  });

  it("pushes a locally built image through the data plane", async () => {
    await deploy("--no-remote");

    expect(gracefulExit).not.toHaveBeenCalled();
    expectHostCalls(DATA_PLANE_HOST, WORKSPACE_ID);
    expect(createBody().source).toBe("internal_docker");
    expect(calls.map((call) => call.route)).toContain(
      `POST ${DATA_PLANE_HOST}/v2/deployments/dep-1/push-token`
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
    serve(DATA_PLANE_HOST, {
      [DISCOVER]: () => json([BYOC_WORKSPACE]),
      [INFO]: () => json({ instance_flags: c.flags }),
    });

    await remoteDeploy(...c.args);

    expect(gracefulExit).toHaveBeenCalledWith(1);
    expect(harness.output).toContain(c.expected);
    expect(createBody()).toBeUndefined();
  });

  it("redeploys an existing prod deployment without dedicated support", async () => {
    serve(DATA_PLANE_HOST, {
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
    serve(DATA_PLANE_HOST, {
      [DISCOVER]: () => json([BYOC_WORKSPACE]),
      [INFO]: () => json({}),
    });

    await remoteDeploy();

    expect(harness.output).toContain("--push-to");
    expect(harness.output).toContain("--image-uri");
  });

  it("surfaces a data plane's 501 as it is", async () => {
    const hint = "Local image pushes are not supported here; use --remote.";
    serve(DATA_PLANE_HOST, {
      [DISCOVER]: () => json([BYOC_WORKSPACE]),
      "POST /v2/deployments": () => json({ detail: hint }, 501),
    });

    await remoteDeploy();

    expect(gracefulExit).toHaveBeenCalledWith(1);
    expect(harness.output).toContain(hint);
  });

  it("reads build logs from the data plane with the workspace", async () => {
    await runDeployCli("logs", "--type", "build", "--deployment-id", "dep-1");

    expect(calls.map((call) => call.route)).toEqual([
      DISCOVER,
      `GET ${DATA_PLANE_HOST}/v2/deployments/dep-1/revisions`,
      `POST ${DATA_PLANE_HOST}/v1/projects/dep-1/revisions/rev-1/build_logs`,
    ]);
    expectHostCalls(DATA_PLANE_HOST, WORKSPACE_ID);
  });

  it("links LangSmith, not the data plane, when deployments are off", async () => {
    serve(DATA_PLANE_HOST, {
      [DISCOVER]: () => json([BYOC_WORKSPACE]),
      "GET /v2/deployments": () =>
        json({ detail: "LangSmith Deployment is not enabled" }, 403),
    });

    await runDeployCli("list");

    expect(harness.output).toContain(
      "https://smith.langchain.com/host/deployments"
    );
    expect(harness.output).not.toContain("customer.example");
  });

  it("links LangSmith when LANGSMITH_ENDPOINT is the data plane", async () => {
    vi.stubEnv("LANGSMITH_ENDPOINT", DATA_PLANE_URL);
    serve(DATA_PLANE_HOST, {
      [`GET ${DATA_PLANE_URL}/api/v1/workspaces`]: () =>
        json([BYOC_WORKSPACE]),
    });

    await remoteDeploy();

    expect(gracefulExit).not.toHaveBeenCalled();
    expect(harness.output).toContain(
      "https://smith.langchain.com/o/tenant-1/host/deployments/dep-1"
    );
  });

  it.each([
    { label: "an empty", tenantId: "" },
    { label: "a blank", tenantId: "  " },
    { label: "an uppercase", tenantId: WORKSPACE_ID.toUpperCase() },
  ])("finds the workspace with $label LANGSMITH_TENANT_ID", async (c) => {
    vi.stubEnv("LANGSMITH_TENANT_ID", c.tenantId);

    await remoteDeploy();

    expect(gracefulExit).not.toHaveBeenCalled();
    expectHostCalls(DATA_PLANE_HOST, WORKSPACE_ID);
  });

  it("refuses a data plane that is not on https", async () => {
    const insecure = "http://langsmith.customer.example";
    serve(`${insecure}/api-host`, {
      [DISCOVER]: () => json([{ ...BYOC_WORKSPACE, data_plane_url: insecure }]),
    });

    await remoteDeploy();

    expect(gracefulExit).toHaveBeenCalledWith(1);
    expect(harness.output).toContain("must use https");
    expect(calls.map((call) => call.route)).toEqual([DISCOVER]);
  });

  it("lets --host-url override discovery", async () => {
    serve("https://host.example.com");

    await remoteDeploy("--host-url", "https://host.example.com");

    expect(calls.map((call) => call.route)).not.toContain(DISCOVER);
    expect(createBody().source_config).toEqual({ deployment_type: "dev" });
  });

  it("hints at dropping --host-url when a data plane asks for resource_spec", async () => {
    const detail =
      "'source_config.resource_spec' is required for 'external_docker' source, and for every source on BYOC data planes, and must be 'null' for all other sources.";
    serve(DATA_PLANE_HOST, {
      "POST /v2/deployments": () => json({ detail }, 400),
    });

    await remoteDeploy("--host-url", DATA_PLANE_HOST);

    expect(gracefulExit).toHaveBeenCalledWith(1);
    expect(calls.map((call) => call.route)).not.toContain(INFO);
    expect(harness.output).toContain(detail);
    expect(harness.output).toContain("drop it so 'langgraphjs deploy' finds");
  });
});

describe("with workspaces on different planes", () => {
  it("follows LANGSMITH_TENANT_ID to its data plane", async () => {
    vi.stubEnv("LANGSMITH_TENANT_ID", OTHER_BYOC_WORKSPACE.id);
    serve(OTHER_DATA_PLANE_HOST, {
      [DISCOVER]: () => json([BYOC_WORKSPACE, OTHER_BYOC_WORKSPACE]),
      [info(OTHER_DATA_PLANE_URL)]: () => json({ instance_flags: ALL_FLAGS }),
    });

    await remoteDeploy();

    expect(gracefulExit).not.toHaveBeenCalled();
    expectHostCalls(OTHER_DATA_PLANE_HOST, OTHER_BYOC_WORKSPACE.id);
  });

  it("follows the prompted workspace to its data plane", async () => {
    promptAnswer.mockReturnValue(WORKSPACE_ID);
    serve(DATA_PLANE_HOST, {
      [DISCOVER]: () => json([SAAS_WORKSPACE, BYOC_WORKSPACE]),
    });

    await runDeployCli("list");

    expect(gracefulExit).not.toHaveBeenCalled();
    expect(harness.output).toContain("requires a workspace ID");
    expectHostCalls(DATA_PLANE_HOST, WORKSPACE_ID);
  });

  it("asks for LANGSMITH_TENANT_ID without input", async () => {
    serve(CLOUD_HOST_URL, {
      [DISCOVER]: () => json([SAAS_WORKSPACE, BYOC_WORKSPACE]),
    });

    await remoteDeploy();

    expect(gracefulExit).toHaveBeenCalledWith(1);
    expect(harness.output).toContain("Set LANGSMITH_TENANT_ID");
    expect(calls.map((call) => call.route)).toEqual([DISCOVER]);
  });
});

describe("off a data plane", () => {
  it.each([
    {
      label: "a LangSmith cloud workspace",
      discover: () => json([SAAS_WORKSPACE]),
      note: false,
    },
    { label: "a failed lookup", discover: () => json({}, 500), note: true },
    {
      label: "an unreachable API",
      discover: () => {
        throw new TypeError("fetch failed");
      },
      note: true,
    },
  ])("keeps today's control plane for $label", async (c) => {
    serve(CLOUD_HOST_URL, { [DISCOVER]: c.discover });

    await remoteDeploy();

    expect(gracefulExit).not.toHaveBeenCalled();
    expect(calls.filter((call) => call.route === DISCOVER)).toHaveLength(1);
    expect(calls.map((call) => call.route)).not.toContain(INFO);
    expectHostCalls(CLOUD_HOST_URL);
    expect(createBody().source_config).toEqual({ deployment_type: "dev" });
    expect(harness.output.includes("Could not look up")).toBe(c.note);
  });

  it("names a LANGSMITH_TENANT_ID the key cannot use", async () => {
    vi.stubEnv("LANGSMITH_TENANT_ID", "unknown-ws");
    serve(CLOUD_HOST_URL, { [DISCOVER]: () => json([BYOC_WORKSPACE]) });

    await remoteDeploy();

    expect(gracefulExit).toHaveBeenCalledWith(1);
    expect(harness.output).toContain("unknown-ws");
    expect(calls.map((call) => call.route)).toEqual([DISCOVER]);
  });

  it("hints at external images when an older data plane rejects the source", async () => {
    serve("https://host.example.com", {
      "POST /v2/deployments": () =>
        json(
          { detail: "'source' must be one of ['github', 'external_docker']" },
          400
        ),
    });

    await remoteDeploy("--host-url", "https://host.example.com");

    expect(gracefulExit).toHaveBeenCalledWith(1);
    expect(harness.output).toContain("'source' must be one of");
    expect(harness.output).toContain("--push-to <registry>/<repository>");
  });
});

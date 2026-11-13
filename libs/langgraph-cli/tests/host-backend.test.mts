import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DataPlaneClient,
  HostBackendClient,
  HostBackendError,
  LangSmithApiClient,
} from "../src/cli/utils/host-backend.mjs";

const BASE = "https://api.host.langchain.com";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("HostBackendClient", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requires a base url", () => {
    expect(() => new HostBackendClient("", "key")).toThrow(HostBackendError);
  });

  it("sends api key + tenant headers and parses JSON", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ resources: [] }));
    const client = new HostBackendClient(BASE, "secret", "tenant-1");
    const result = await client.listDeployments("foo");

    expect(result).toEqual({ resources: [] });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      "https://api.host.langchain.com/v2/deployments?name_contains=foo"
    );
    expect(init.method).toBe("GET");
    expect(init.headers["X-Api-Key"]).toBe("secret");
    expect(init.headers["X-Tenant-ID"]).toBe("tenant-1");
  });

  it("builds the create-deployment payload", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: "dep-1" }));
    const client = new HostBackendClient(BASE, "secret");
    const created = await client.createDeployment({
      name: "my-app",
      sourceConfig: { deployment_type: "dev" },
      source: "internal_source",
      configPath: "langgraph.json",
      secrets: [{ name: "A", value: "1" }],
    });

    expect(created).toEqual({ id: "dep-1" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://api.host.langchain.com/v2/deployments");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      name: "my-app",
      source: "internal_source",
      source_config: { deployment_type: "dev" },
      source_revision_config: { langgraph_config_path: "langgraph.json" },
      secrets: [{ name: "A", value: "1" }],
    });
  });

  it("requests a push token that may use the registry's own username", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ token: "t" }));
    const client = new HostBackendClient(BASE, "secret");
    await client.requestPushToken("dep-1");

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      "https://api.host.langchain.com/v2/deployments/dep-1/push-token"
    );
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ supports_registry_username: true });
  });

  it("requests an upload URL whose required headers it sends", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ upload_url: "u" }));
    const client = new HostBackendClient(BASE, "secret");
    await client.requestUploadUrl("dep-1");

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      "https://api.host.langchain.com/v2/deployments/dep-1/upload-url"
    );
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ supports_upload_headers: true });
  });

  it("throws HostBackendError with status on non-2xx", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("nope", { status: 403 })
    );
    const client = new HostBackendClient(BASE, "secret");
    await expect(client.getDeployment("dep-1")).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it("retries transport errors then succeeds", async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError("network down"))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const client = new HostBackendClient(BASE, "secret");
    const result = await client.getDeployment("dep-1");
    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("setTenantId updates subsequent requests", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    const client = new HostBackendClient(BASE, "secret");
    client.setTenantId("tenant-9");
    await client.getDeployment("dep-1");
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers["X-Tenant-ID"]).toBe("tenant-9");
  });

  it("keeps a string detail from an error response", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ detail: "bad source" }, 400));
    const client = new HostBackendClient(BASE, "secret");
    await expect(client.getDeployment("dep-1")).rejects.toMatchObject({
      statusCode: 400,
      detail: "bad source",
    });
  });

  it("has no data plane capabilities off a data plane", async () => {
    expect(await new HostBackendClient(BASE, "secret").instanceFlags()).toBeNull();
  });

  it("links the dashboard for its host unless given one", () => {
    expect(
      new HostBackendClient("https://eu.api.host.langchain.com", "secret")
        .dashboardUrl
    ).toBe("https://eu.smith.langchain.com");
    expect(
      new HostBackendClient(BASE, "secret", undefined, "https://smith.example.com")
        .dashboardUrl
    ).toBe("https://smith.example.com");
  });
});

describe("LangSmithApiClient", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists the key's live workspaces with their data planes", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse([
        { id: "ws-1", data_plane_url: "https://dp.example.com/" },
        { id: "ws-2", data_plane_url: null },
        { id: "ws-3", data_plane_url: "" },
        { id: "ws-4", data_plane_url: "https://old.example.com", is_deleted: true },
        { data_plane_url: "https://no-id.example.com" },
      ])
    );
    const client = new LangSmithApiClient("https://api.smith.langchain.com/", "secret");

    expect(await client.listWorkspaces()).toEqual([
      { id: "ws-1", dataPlaneUrl: "https://dp.example.com" },
      { id: "ws-2", dataPlaneUrl: null },
      { id: "ws-3", dataPlaneUrl: null },
    ]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      "https://api.smith.langchain.com/api/v1/workspaces"
    );
    expect(init.headers["X-Api-Key"]).toBe("secret");
  });

  it("makes one attempt when told not to retry", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    const client = new LangSmithApiClient("https://api.smith.langchain.com", "secret", {
      retries: 0,
    });

    await expect(client.listWorkspaces()).rejects.toBeInstanceOf(HostBackendError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      label: "all supported",
      info: {
        instance_flags: {
          deployments_cli_builds_supported: true,
          deployments_dedicated_supported: true,
        },
      },
      expected: { cliBuilds: true, dedicated: true },
    },
    {
      label: "a missing flag",
      info: { instance_flags: { deployments_dedicated_supported: true } },
      expected: { cliBuilds: false, dedicated: true },
    },
    {
      label: "an older data plane without instance flags",
      info: {},
      expected: { cliBuilds: false, dedicated: false },
    },
  ])("reads instance flags with $label", async ({ info, expected }) => {
    fetchMock.mockResolvedValueOnce(jsonResponse(info));
    const client = new LangSmithApiClient("https://dp.example.com", "secret");

    expect(await client.getInstanceFlags()).toEqual(expected);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "https://dp.example.com/api/v1/info"
    );
  });
});

describe("DataPlaneClient", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps a langchain.com data plane host and links the LangSmith UI", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ instance_flags: {} }));
    const client = new DataPlaneClient(
      "https://byoc.langchain.com/",
      "secret",
      "ws-1",
      "https://eu.smith.langchain.com"
    );

    expect(client.baseUrl).toBe("https://byoc.langchain.com/api-host");
    expect(client.dashboardUrl).toBe("https://eu.smith.langchain.com");
    await client.instanceFlags();
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "https://byoc.langchain.com/api/v1/info"
    );
  });
});

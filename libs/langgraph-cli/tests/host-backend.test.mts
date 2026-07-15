import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HostBackendClient,
  HostBackendError,
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
      deploymentType: "dev",
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
});

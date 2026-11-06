import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HostBackendClient,
  HostBackendError,
} from "../src/cli/utils/host-backend.mjs";
import { findDeploymentIdByName } from "../src/cli/utils/deploy-helpers.mjs";

const page = (resources: unknown[]) =>
  new Response(JSON.stringify({ resources }));
const firstPage = Array.from({ length: 100 }, (_, id) => ({
  id: `dep-${id}`,
  name: `preview-${id}`,
}));

afterEach(() => vi.unstubAllGlobals());

describe("HostBackendClient deployment listing pagination", () => {
  it("finds an exact deployment after the first page and keeps the filters", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(page(firstPage))
      .mockResolvedValueOnce(page([{ id: "target", name: "preview" }]));
    vi.stubGlobal("fetch", fetch);
    const client = new HostBackendClient(
      "https://api.host.langchain.com",
      "test-key"
    );
    const result = await client.listDeployments("preview", "agent", "dev");
    expect(findDeploymentIdByName(result, "preview")).toBe("target");
    expect(result.resources).toHaveLength(101);
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const [index, [url]] of fetch.mock.calls.entries()) {
      expect(Object.fromEntries(new URL(url).searchParams)).toEqual({
        name_contains: "preview",
        agent_id: "agent",
        agent_environment: "dev",
        limit: "100",
        offset: String(index * 100),
      });
    }
  });

  it("fails instead of looping when the server ignores offset", async () => {
    const fetch = vi.fn().mockImplementation(async () => page(firstPage));
    vi.stubGlobal("fetch", fetch);
    const client = new HostBackendClient(
      "https://api.host.langchain.com",
      "test-key"
    );
    await expect(client.listDeployments()).rejects.toBeInstanceOf(
      HostBackendError
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("stops after the empty page following an exact page boundary", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(page(firstPage))
      .mockResolvedValueOnce(page([]));
    vi.stubGlobal("fetch", fetch);
    const client = new HostBackendClient(
      "https://api.host.langchain.com",
      "test-key"
    );
    expect((await client.listDeployments()).resources).toEqual(firstPage);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

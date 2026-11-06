import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HostBackendClient,
  HostBackendError,
} from "../src/cli/utils/host-backend.mjs";

const client = () =>
  new HostBackendClient("https://api.host.langchain.com", "test-key");
const mutate = (method: "POST" | "PATCH") =>
  method === "POST"
    ? client().createDeployment({
        name: "test",
        source: "internal_source",
        deploymentType: "dev",
      })
    : client().updateDeployment("deployment", "registry/image:latest");

afterEach(() => vi.unstubAllGlobals());

describe("HostBackendClient mutation retries", () => {
  it.each(["POST", "PATCH"] as const)(
    "does not repeat %s after a lost response",
    async (method) => {
      const fetch = vi
        .fn()
        .mockRejectedValueOnce(
          new TypeError("fetch failed", { cause: { code: "ECONNRESET" } })
        )
        .mockResolvedValue(new Response("{}"));
      vi.stubGlobal("fetch", fetch);
      await expect(mutate(method)).rejects.toBeInstanceOf(HostBackendError);
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  );

  it.each(["POST", "PATCH"] as const)(
    "does not repeat %s after an unclassified network failure",
    async (method) => {
      const fetch = vi
        .fn()
        .mockRejectedValueOnce(new TypeError("network error"))
        .mockResolvedValue(new Response("{}"));
      vi.stubGlobal("fetch", fetch);
      await expect(mutate(method)).rejects.toBeInstanceOf(HostBackendError);
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  );

  it.each(["ECONNREFUSED", "ENOTFOUND", "UND_ERR_CONNECT_TIMEOUT"])(
    "retries a mutation after %s before connecting",
    async (code) => {
      const fetch = vi
        .fn()
        .mockRejectedValueOnce(
          new TypeError("fetch failed", { cause: { code } })
        )
        .mockResolvedValue(new Response('{"id":"created"}'));
      vi.stubGlobal("fetch", fetch);
      await expect(mutate("POST")).resolves.toEqual({ id: "created" });
      expect(fetch).toHaveBeenCalledTimes(2);
    }
  );

  it("still bounds retries of connection failures", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValue(
        new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } })
      );
    vi.stubGlobal("fetch", fetch);
    await expect(mutate("POST")).rejects.toBeInstanceOf(HostBackendError);
    expect(fetch).toHaveBeenCalledTimes(4);
  });
});

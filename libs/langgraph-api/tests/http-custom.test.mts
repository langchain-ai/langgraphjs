import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { registerHttp, registerHttpApps } from "../src/http/custom.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const graphsDir = resolve(__dirname, "graphs");

describe("registerHttp", () => {
  it("loads a local Hono app", async () => {
    const { api } = await registerHttp("./dashboard.mts:app", {
      cwd: graphsDir,
    });
    const res = await api.request("/");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ name: "dashboard", status: "ok" });
  });
});

describe("registerHttpApps", () => {
  it("loads multiple apps with path prefixes", async () => {
    const apps = await registerHttpApps(
      {
        "/dashboard": "./dashboard.mts:app",
        "/ext": "./extension.mts:app",
      },
      { cwd: graphsDir }
    );

    expect(apps).toHaveLength(2);
    expect(apps[0].prefix).toBe("/dashboard");
    expect(apps[1].prefix).toBe("/ext");
  });

  it("normalizes prefixes without leading slash", async () => {
    const apps = await registerHttpApps(
      { dashboard: "./dashboard.mts:app" },
      { cwd: graphsDir }
    );

    expect(apps[0].prefix).toBe("/dashboard");
  });

  it("loaded apps respond correctly", async () => {
    const apps = await registerHttpApps(
      {
        "/dashboard": "./dashboard.mts:app",
        "/ext": "./extension.mts:app",
      },
      { cwd: graphsDir }
    );

    const dashRes = await apps[0].api.request("/metrics");
    expect(dashRes.status).toBe(200);
    expect(await dashRes.json()).toEqual({ runs: 42, threads: 7 });

    const extRes = await apps[1].api.request("/health");
    expect(extRes.status).toBe(200);
    expect(await extRes.json()).toEqual({ healthy: true });
  });

  it("rejects invalid app path", async () => {
    await expect(
      registerHttpApps({ "/bad": "./nonexistent.mts:app" }, { cwd: graphsDir })
    ).rejects.toThrow();
  });
});

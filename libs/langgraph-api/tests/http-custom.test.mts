import { afterAll, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { registerHttp, registerHttpApps } from "../src/http/custom.mjs";
import type { AppRegistration } from "../src/http/custom.mjs";

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

  it("JS apps have no cleanup function", async () => {
    const apps = await registerHttpApps(
      { "/dashboard": "./dashboard.mts:app" },
      { cwd: graphsDir }
    );
    expect(apps[0].cleanup).toBeUndefined();
  });
});

function hasPython(): boolean {
  try {
    execSync("python3 -c 'import uvicorn'", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("cross-language Python apps", () => {
  const tmpDir = resolve(__dirname, ".tmp-python-test");
  const cleanups: Array<() => Promise<void>> = [];

  afterAll(async () => {
    await Promise.all(cleanups.map((fn) => fn()));
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it.skipIf(!hasPython())(
    "spawns a Python ASGI app and proxies to it",
    async () => {
      mkdirSync(tmpDir, { recursive: true });
      writeFileSync(
        join(tmpDir, "test_app.py"),
        `from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Route

async def homepage(request):
    return JSONResponse({"source": "python", "status": "ok"})

app = Starlette(routes=[Route("/", homepage)])
`
      );

      const result = await registerHttp("./test_app.py:app", { cwd: tmpDir });
      expect(result.cleanup).toBeDefined();
      cleanups.push(result.cleanup!);

      const res = await result.api.request("/");
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toEqual({ source: "python", status: "ok" });
    },
    30_000
  );

  it.skipIf(!hasPython())(
    "registers Python app in multi-app config with cleanup",
    async () => {
      mkdirSync(tmpDir, { recursive: true });
      writeFileSync(
        join(tmpDir, "py_ext.py"),
        `from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Route

async def health(request):
    return JSONResponse({"healthy": True})

app = Starlette(routes=[Route("/health", health)])
`
      );

      const apps: AppRegistration[] = await registerHttpApps(
        { "/py": "./py_ext.py:app" },
        { cwd: tmpDir }
      );

      expect(apps).toHaveLength(1);
      expect(apps[0].prefix).toBe("/py");
      expect(apps[0].cleanup).toBeDefined();
      cleanups.push(apps[0].cleanup!);

      const res = await apps[0].api.request("/health");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ healthy: true });
    },
    30_000
  );
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ChildProcess, spawn } from "node:child_process";
import waitPort from "wait-port";
import { truncate } from "./utils.mjs";

const PORT = 2026;
const API_URL = `http://localhost:${PORT}`;
let server: ChildProcess | undefined;

beforeAll(async () => {
  if (process.env.CI) {
    server = spawn(
      "tsx",
      ["./tests/utils.server.mts", "-c", "./graphs/langgraph.apps.json"],
      {
        stdio: "overlapped",
        env: { ...process.env, PORT: String(PORT) },
        shell: true,
        cwd: new URL(".", import.meta.url).pathname,
      }
    );

    server.stdout?.on("data", (data) => console.log(data.toString().trimEnd()));
    server.stderr?.on("data", (data) => console.log(data.toString().trimEnd()));

    await waitPort({ port: PORT, timeout: 30_000 });
  }

  await truncate(API_URL, "all");
}, 60_000);

afterAll(() => server?.kill("SIGTERM"));

describe("multi-app support", () => {
  describe("built-in routes still work", () => {
    it("GET /ok returns health check", async () => {
      const res = await fetch(`${API_URL}/ok`);
      expect(res.ok).toBe(true);
    });

    it("GET /info returns server info", async () => {
      const res = await fetch(`${API_URL}/info`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data).toHaveProperty("version");
    });
  });

  describe("root http.app routes work", () => {
    it("GET /custom/my-route returns custom route", async () => {
      const res = await fetch(`${API_URL}/custom/my-route`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data).toEqual({ foo: "bar" });
    });
  });

  describe("dashboard app at /dashboard", () => {
    it("GET /dashboard/ returns dashboard info", async () => {
      const res = await fetch(`${API_URL}/dashboard/`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data).toEqual({ name: "dashboard", status: "ok" });
    });

    it("GET /dashboard/metrics returns metrics", async () => {
      const res = await fetch(`${API_URL}/dashboard/metrics`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data).toEqual({ runs: 42, threads: 7 });
    });
  });

  describe("extension app at /ext", () => {
    it("GET /ext/ returns extension info", async () => {
      const res = await fetch(`${API_URL}/ext/`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data).toEqual({ name: "extension", version: "1.0.0" });
    });

    it("GET /ext/health returns health status", async () => {
      const res = await fetch(`${API_URL}/ext/health`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data).toEqual({ healthy: true });
    });

    it("POST /ext/webhook echoes body", async () => {
      const payload = { event: "message", text: "hello" };
      const res = await fetch(`${API_URL}/ext/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data).toEqual({ received: payload });
    });
  });
});

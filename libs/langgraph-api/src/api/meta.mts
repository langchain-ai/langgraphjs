import { Hono } from "hono";
import * as fs from "node:fs/promises";
import * as url from "node:url";

const api = new Hono();

// Get the version using the same pattern as semver/index.mts
const packageJsonPath = url.fileURLToPath(
  new URL("../../package.json", import.meta.url)
);

let version: string;
try {
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf-8"));
  version = packageJson.version;
} catch {
  console.warn("Could not determine version of langgraph-api");
}

// read env variable
const env = process.env;

api.get("/info", (c) => {
  const langsmithApiKey = env["LANGSMITH_API_KEY"] || env["LANGCHAIN_API_KEY"];

  const langsmithTracing = (() => {
    if (langsmithApiKey) {
      // Check if any tracing variable is explicitly set to "false"
      const tracingVars = [
        env["LANGCHAIN_TRACING_V2"],
        env["LANGCHAIN_TRACING"],
        env["LANGSMITH_TRACING_V2"],
        env["LANGSMITH_TRACING"],
      ];

      // Return true unless explicitly disabled
      return !tracingVars.some((val) => val === "false" || val === "False");
    }
    return undefined;
  })();
  return c.json({
    version,
    context: "js",
    flags: {
      assistants: true,
      crons: false,
      langsmith: !!langsmithTracing,
      langsmith_tracing_replicas: true,
    },
  });
});

api.get("/ok", (c) => c.json({ ok: true }));

export default api;

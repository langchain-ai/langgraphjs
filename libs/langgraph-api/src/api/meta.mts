import { Hono } from "hono";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as url from "node:url";

const api = new Hono();

// Get the version using the same pattern as semver/index.mts
const packageJsonPath = path.resolve(
  url.fileURLToPath(import.meta.url),
  "../../../package.json"
);

let version: string;
let langgraph_js_version: string;
let versionInfoLoaded = false;

const loadVersionInfo = async () => {
  try {
    const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf-8"));
    version = packageJson.version;
  } catch {
    console.warn("Could not determine version of langgraph-api");
  }

  // Get the installed version of @langchain/langgraph
  try {
    const langgraphPkg = await import("@langchain/langgraph/package.json");
    if (langgraphPkg?.default?.version) {
      langgraph_js_version = langgraphPkg.default.version;
    }
  } catch {
    console.warn("Could not determine version of @langchain/langgraph");
  }
};

// read env variable
const env = process.env;

api.get("/info", async (c) => {
  if (!versionInfoLoaded) {
    await loadVersionInfo();
    versionInfoLoaded = true;
  }

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
    langgraph_js_version,
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

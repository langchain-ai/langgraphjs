import { Hono } from "hono";

const api = new Hono();

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
    flags: { assistants: true, crons: false, langsmith: !!langsmithTracing },
    env,
  });
});

api.get("/ok", (c) => c.json({ ok: true }));

export default api;

import "../preload.mjs";

import * as process from "node:process";
import { startServer, StartServerSchema } from "../server.mjs";
import { connectToServer } from "./utils/ipc/client.mjs";
import { Client as LangSmithClient } from "langsmith";
import { logger } from "../logging.mjs";

const [ppid, payload] = process.argv.slice(-2);
const sendToParent = await connectToServer(+ppid);

// TODO: re-export langsmith/isTracingEnabled
const isTracingEnabled = () => {
  const value =
    process.env?.LANGSMITH_TRACING_V2 ||
    process.env?.LANGCHAIN_TRACING_V2 ||
    process.env?.LANGSMITH_TRACING ||
    process.env?.LANGCHAIN_TRACING;
  return value === "true";
};

const [host, organizationId] = await Promise.all([
  startServer(StartServerSchema.parse(JSON.parse(payload))),
  (async () => {
    if (isTracingEnabled()) {
      try {
        // @ts-expect-error Private method
        return new LangSmithClient()._getTenantId();
      } catch (error) {
        logger.warn("Failed to get organization ID", { error });
      }
    }
    return null;
  })(),
]);

sendToParent?.({ host, organizationId });

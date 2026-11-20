import * as process from "node:process";

export const isTracingEnabled = () => {
  const value =
    process.env?.LANGSMITH_TRACING_V2 ||
    process.env?.LANGCHAIN_TRACING_V2 ||
    process.env?.LANGSMITH_TRACING ||
    process.env?.LANGCHAIN_TRACING;
  return value === "true";
};
